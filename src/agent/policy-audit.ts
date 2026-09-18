import type { ProposalRoutingInput, ProposalRoutingResult } from './policy.js';

type Safety = { outcome: 'allow' | 'reject'; reasons?: readonly string[] };
const MAX_ITEMS = 32;
const MAX_REASON = 300;
function strings(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  return values.slice(0, MAX_ITEMS).flatMap((value) => typeof value === 'string' ? [value.slice(0, MAX_REASON)] : []);
}
function finite(value: number | null | undefined): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }

export interface EpisodePolicyDecisionAudit {
  version: 1;
  kind: 'episode_intervention';
  mode: string;
  state: string;
  score: number;
  thresholds: { score: number; confidence: number; evidenceStrength: number; maxContentLength: number };
  eligibility: {
    recommend: boolean; dimensions: Record<string, number>; confidence: number; evidenceStrength: number;
    evidenceCount: number; contentLength: number;
  };
  outboundSafety: { outcome: 'allow' | 'reject'; reasons: string[] };
  provenanceGate: { outcome: string; reasons: string[] };
  outboundEvidence: { outcome: string; reasons: string[] };
  forcedReview: { forceReview: boolean; rules: Array<{ rule: string; detail: string }> };
  cooldown: { allowed: boolean; blocks: Array<{ rule: string; retryAfterMs: number }> };
  duplicate: { matched: boolean; kind?: string; similarity?: number; source?: string };
  /** Proactive attention admission (Section 12.7): bounded codes and windows only. */
  attention: {
    required: boolean;
    eligible: boolean;
    reason?: string;
    revisionId?: string;
    windowFromMs: number;
    windowUntilMs: number;
  };
  /** Conversation settle gate (Section 11.8): quiet state of the target channel. */
  liveness: { settled: boolean; idleMs: number };
  reasons: string[];
}

export function buildEpisodePolicyDecision(
  input: ProposalRoutingInput,
  result: ProposalRoutingResult,
  outboundSafety: Safety,
): EpisodePolicyDecisionAudit {
  const dimensions = input.eligibility.dimensions;
  const duplicate = input.duplicate as unknown as Record<string, unknown>;
  return {
    version: 1, kind: 'episode_intervention', mode: input.mode, state: result.state,
    score: finite(result.score),
    thresholds: {
      score: finite(input.thresholds.score), confidence: finite(input.thresholds.confidence),
      evidenceStrength: finite(input.thresholds.evidenceStrength), maxContentLength: finite(input.thresholds.maxContentLength),
    },
    eligibility: {
      recommend: input.eligibility.recommend,
      dimensions: {
        impact: finite(dimensions.impact), evidenceStrength: finite(dimensions.evidenceStrength),
        contradictionStrength: finite(dimensions.contradictionStrength), urgency: finite(dimensions.urgency),
        novelty: finite(dimensions.novelty), interruptionCost: finite(dimensions.interruptionCost),
      },
      confidence: finite(input.eligibility.confidence), evidenceStrength: finite(input.eligibility.evidenceStrength),
      evidenceCount: finite(input.eligibility.evidenceCount), contentLength: finite(input.eligibility.contentLength),
    },
    outboundSafety: { outcome: outboundSafety.outcome, reasons: strings(outboundSafety.reasons) },
    provenanceGate: { outcome: input.provenanceGate.outcome, reasons: strings(input.provenanceGate.reasons) },
    outboundEvidence: { outcome: input.outboundEvidence.outcome, reasons: strings(input.outboundEvidence.reasons) },
    forcedReview: { forceReview: input.forcedReview.forceReview, rules: input.forcedReview.rules.slice(0, MAX_ITEMS).map((rule) => ({ rule: rule.rule.slice(0, 80), detail: rule.detail.slice(0, MAX_REASON) })) },
    cooldown: {
      allowed: input.cooldown.allowed,
      blocks: input.cooldown.blocks.slice(0, MAX_ITEMS).map((block) => ({ rule: block.rule.slice(0, 80), retryAfterMs: finite(block.retryAfterMs) })),
    },
    duplicate: {
      matched: duplicate.matched === true,
      ...(typeof duplicate.kind === 'string' ? { kind: duplicate.kind.slice(0, 80) } : {}),
      ...(typeof duplicate.similarity === 'number' ? { similarity: finite(duplicate.similarity) } : {}),
      ...(typeof duplicate.source === 'string' ? { source: duplicate.source.slice(0, 80) } : {}),
    },
    attention: {
      required: input.attention.required === true,
      eligible: input.attention.eligible !== false,
      ...(typeof input.attention.reason === 'string' ? { reason: input.attention.reason.slice(0, 80) } : {}),
      ...(typeof input.attention.revisionId === 'string' ? { revisionId: input.attention.revisionId.slice(0, 80) } : {}),
      windowFromMs: finite(input.attention.windowFromMs),
      windowUntilMs: finite(input.attention.windowUntilMs),
    },
    liveness: {
      settled: input.liveness.settled !== false,
      idleMs: finite(input.liveness.idleMs),
    },
    reasons: strings(result.reasons),
  };
}

export interface ScheduledPolicyDecisionAudit {
  version: 1; kind: 'scheduled_notification'; mode: string; state: string; recommend: boolean;
  notificationsAllowed: boolean; targetMatches: boolean;
  outboundSafety: { outcome: 'allow' | 'reject'; reasons: string[] };
  subjectValidation: { valid: boolean; blockingReasons: string[] };
  /** Proactive attention admission (Section 12.7): bounded codes and windows only. */
  attention: {
    mode: string;
    pinned: boolean;
    eligible: boolean;
    reason?: string;
    revisionId?: string;
    windowFromMs: number;
    windowUntilMs: number;
  };
  reasons: string[];
}
export function buildScheduledPolicyDecision(input: {
  mode: string; state: string; recommend: boolean; notificationsAllowed: boolean;
  targetMatches: boolean; outboundSafety: Safety; subjectBlockingReasons: readonly string[];
  reasons: readonly string[];
  attention?: {
    mode: string; pinned: boolean; eligible: boolean; reason?: string;
    revisionId?: string; windowFromMs: number; windowUntilMs: number;
  };
}): ScheduledPolicyDecisionAudit {
  return {
    version: 1, kind: 'scheduled_notification', mode: input.mode.slice(0, 40), state: input.state.slice(0, 40),
    recommend: input.recommend, notificationsAllowed: input.notificationsAllowed, targetMatches: input.targetMatches,
    outboundSafety: { outcome: input.outboundSafety.outcome, reasons: strings(input.outboundSafety.reasons) },
    subjectValidation: { valid: input.subjectBlockingReasons.length === 0, blockingReasons: strings(input.subjectBlockingReasons) },
    attention: input.attention ?? {
      mode: '', pinned: false, eligible: true, windowFromMs: 0, windowUntilMs: 0,
    },
    reasons: strings(input.reasons),
  };
}

export function unavailablePolicyDecision(reason = 'evaluation unavailable'): Record<string, unknown> {
  return { version: 1, kind: 'episode_intervention', state: 'observed', evaluationAvailable: false, reasons: strings([reason]) };
}
