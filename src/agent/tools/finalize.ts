import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static, type TSchema } from '@sinclair/typebox';
import {
  FinalizeEpisodeReview,
  FinalizeDirectAnswer,
  FinalizeScheduledReview,
  validate,
} from '../schemas.js';

/**
 * Terminal finalization tools (Sections 21.1, 22.8, 23).
 *
 * A run finishes through exactly one terminal tool. The tool validates the
 * proposal against its schema and the run's pinned target, stores the accepted
 * proposal (on the run record, never in memory), and returns `terminate: true`.
 * It never mutates a memory, posts to Discord, or changes the target: the model
 * supplies a declarative `targetChannelId` and the host rejects the finalization
 * when it differs from the pinned target.
 *
 * A rejected finalization is correctable exactly once (Section 21.2). The first
 * semantic rejection — a schema or target mismatch that reached `execute` —
 * returns a non-terminating error so the model can retry; a second rejection
 * fails the run by throwing. Schema arguments are validated by the agent runtime
 * before `execute` is called, so in practice only target and host-owned
 * semantic/policy mismatches consume the single correction.
 */

export type TerminalKind = 'episode_review' | 'direct_answer' | 'scheduled_review';

export interface AcceptedProposal {
  kind: TerminalKind;
  /** The schema-valid proposal payload (stored verbatim on the run record). */
  proposal: unknown;
}

export interface FinalizeDetails {
  accepted: boolean;
  kind: TerminalKind;
  attempts: number;
  error?: string;
  proposal?: unknown;
}

/**
 * Per-run finalization gate. Tracks attempts, holds the pinned target, and
 * remembers the accepted proposal so the run orchestrator can persist it.
 */
export class RunFinalizationState {
  /** Total finalize attempts (accepted or rejected) on this run. */
  attempts = 0;
  accepted: AcceptedProposal | null = null;
  private rejections = 0;

  constructor(readonly pinnedTargetChannelId: string) {}

  /** True after the model has spent its single finalization correction. */
  get correctionExhausted(): boolean {
    return this.rejections > 1;
  }

  /** Record a correctable rejection; throws once the single correction is spent. */
  reject(error: string): void {
    this.attempts += 1;
    this.rejections += 1;
    if (this.rejections > 1) {
      throw new Error(`Finalization rejected again after one correction: ${error}`);
    }
  }

  /** Accept a schema-valid, correctly-targeted proposal. */
  accept(kind: TerminalKind, proposal: unknown): void {
    if (this.correctionExhausted) {
      throw new Error('Finalization cannot be accepted after the correction opportunity was exhausted.');
    }
    this.attempts += 1;
    this.accepted = { kind, proposal };
  }
}

/** Commit the accepted proposal to the run record (agent_runs.final_proposal_json). */
export type FinalizeCommit = (proposal: AcceptedProposal) => void;

/**
 * Optional host-owned semantic check that runs after schema and pinned-target
 * validation but before a terminal proposal is accepted. Returning an error
 * consumes the same single correction opportunity as every other semantic
 * finalization rejection.
 */
export type FinalizeSemanticValidator<TSchemaInput extends TSchema> = (
  proposal: Static<TSchemaInput>,
) => string | null;

function makeFinalizeTool<TSchemaInput extends TSchema>(opts: {
  name: string;
  label: string;
  description: string;
  schema: TSchemaInput;
  kind: TerminalKind;
  extractTarget: (params: Static<TSchemaInput>) => string;
  state: RunFinalizationState;
  commit?: FinalizeCommit;
  semanticValidator?: FinalizeSemanticValidator<TSchemaInput>;
}): AgentTool<TSchemaInput, FinalizeDetails> {
  const {
    name,
    label,
    description,
    schema,
    kind,
    extractTarget,
    state,
    commit,
    semanticValidator,
  } = opts;
  return {
    name,
    label,
    description,
    parameters: schema,
    async execute(
      _toolCallId,
      params: Static<TSchemaInput>,
    ): Promise<AgentToolResult<FinalizeDetails>> {
      const checked = validate(schema, params);
      if (!checked.ok) {
        const error =
          'Proposal failed validation: ' +
          checked.errors.map((e) => `${e.path || '(root)'} (${e.message})`).join('; ');
        state.reject(error);
        return rejection(state, kind, error);
      }

      const declarativeTarget = extractTarget(params);
      if (declarativeTarget !== state.pinnedTargetChannelId) {
        const error =
          `targetChannelId "${declarativeTarget}" does not match this run's pinned ` +
          `target "${state.pinnedTargetChannelId}"; the model cannot retarget a proposal.`;
        state.reject(error);
        return rejection(state, kind, error);
      }

      const semanticError = semanticValidator?.(params);
      if (semanticError) {
        state.reject(semanticError);
        return rejection(state, kind, semanticError);
      }

      state.accept(kind, params);
      commit?.({ kind, proposal: params });
      return {
        content: [
          { type: 'text', text: `${label} accepted. Run will terminate.` } as TextContent,
        ],
        details: {
          accepted: true,
          kind,
          attempts: state.attempts,
          proposal: params,
        },
        terminate: true,
      };
    },
  };
}

/** Build a non-terminating correction result (does not throw — the model retries). */
function rejection(
  state: RunFinalizationState,
  kind: TerminalKind,
  error: string,
): AgentToolResult<FinalizeDetails> {
  return {
    content: [
      {
        type: 'text',
        text: `Finalization rejected: ${error} Correct the proposal and call the tool once more.`,
      } as TextContent,
    ],
    details: { accepted: false, kind, attempts: state.attempts, error },
    terminate: false,
  };
}

// ---- Public factories ------------------------------------------------------

export function createFinalizeEpisodeReviewTool(
  state: RunFinalizationState,
  commit?: FinalizeCommit,
): AgentTool<typeof FinalizeEpisodeReview, FinalizeDetails> {
  return makeFinalizeTool({
    name: 'finalize_episode_review',
    label: 'Finalize episode review',
    description:
      'Submit the episode review: summary, memory proposals, an intervention recommendation, and unresolved questions. Terminates the run. The target channel is pinned by the host.',
    schema: FinalizeEpisodeReview,
    kind: 'episode_review',
    extractTarget: (p) => p.intervention.targetChannelId,
    state,
    commit,
  });
}

export function createFinalizeDirectAnswerTool(
  state: RunFinalizationState,
  commit?: FinalizeCommit,
  semanticValidator?: FinalizeSemanticValidator<typeof FinalizeDirectAnswer>,
): AgentTool<typeof FinalizeDirectAnswer, FinalizeDetails> {
  return makeFinalizeTool({
    name: 'finalize_direct_answer',
    label: 'Finalize direct answer',
    description:
      'Submit a direct answer to one addressed question with up to three cited source links. Terminates the run. The target channel is pinned by the host.',
    schema: FinalizeDirectAnswer,
    kind: 'direct_answer',
    extractTarget: (p) => p.targetChannelId,
    state,
    commit,
    semanticValidator,
  });
}

export function createFinalizeScheduledReviewTool(
  state: RunFinalizationState,
  commit?: FinalizeCommit,
): AgentTool<typeof FinalizeScheduledReview, FinalizeDetails> {
  return makeFinalizeTool({
    name: 'finalize_scheduled_review',
    label: 'Finalize scheduled review',
    description:
      'Submit the scheduled review: memory proposals and an optional notification for the exact working target already pinned by the host. Terminates the run; the model cannot retarget it.',
    schema: FinalizeScheduledReview,
    kind: 'scheduled_review',
    extractTarget: (p) => p.notification.targetChannelId,
    state,
    commit,
  });
}
