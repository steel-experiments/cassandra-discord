import { type DatabaseSync } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { getUser } from '../db/repositories/users.js';
import type { RetrievalGrant } from '../db/repositories/message-search.js';
import { getChannel } from '../db/repositories/channels.js';
import { getMemoryDetails } from '../memory/search.js';
import {
  createMemory,
  confirmMemory,
  updateMemory,
  supersedeMemory,
  resolveMemory,
  invalidateMemory,
  getMemory,
  MemoryValidationError,
  type EvidenceStance,
  type MemoryEvidenceInput,
  type MemoryType,
} from '../memory/repository.js';
import type { Logger } from '../logger.js';
import { findDuplicateCandidates } from '../memory/deduplicate.js';

/**
 * Host validation gate between an agent's memory proposals and the memory
 * repository (Sections 7, 12.2, 12.3, 23).
 *
 * The model proposes; the host validates and acts. This module turns each
 * accepted {@link FinalizeEpisodeReview.memoryProposals} entry into the
 * corresponding repository mutation, but only after the host independently
 * verifies every cited message and lifecycle target. The repository remains the
 * authority for evidence scope and lifecycle transitions (it throws on a
 * violation); this layer adds the checks the repository cannot make and turns
 * every failure into an auditable, per-proposal rejection so one bad proposal
 * never aborts the batch.
 *
 * Rejection reasons (auditable, retained for evaluation):
 *   - `invented_evidence`     — a cited message id does not exist
 *   - `deleted_evidence`      — a cited message is tombstoned
 *   - `evidence_not_exposed`  — a cited message lives in a channel the model did
 *                               not see this run (a guessed-but-real id)
 *   - `evidence_out_of_scope` — the repository rejected the evidence as outside
 *                               the run's retrieval scope (Section 7.3)
 *   - `no_evidence`           — the proposal cited fewer than one message
 *   - `missing_target`        — a lifecycle action named no existing memory
 *   - `target_not_found`      — the named existing memory does not exist
 *   - `owner_not_found`       — a named owner user does not exist
 *   - `invalid_review_at`     — `reviewAt` is not a usable date-time
 *   - `malformed_proposal`    — a structurally invalid proposal (bad types/ranges)
 *   - `repository_error`      — the repository rejected the proposal for another
 *                               validated reason (status, stance, scope, …)
 */

export type MemoryAction =
  | 'create'
  | 'confirm'
  | 'update'
  | 'supersede'
  | 'resolve'
  | 'invalidate';

/** Structural shape of one agent memory proposal (the host re-validates). */
export interface AgentMemoryProposal {
  action: MemoryAction;
  type?: string;
  statement?: string;
  existingMemoryId?: string;
  confidence: number;
  importance: number;
  evidenceMessageIds: string[];
  evidenceQuotes: Array<{ messageId: string; quote: string }>;
  durability: 'transient' | 'project' | 'organizational';
  durabilityReason: string;
  independentReason?: string;
  ownerUserId?: string;
  reviewAt?: string;
  metadata?: Record<string, unknown>;
}

export type ProposalRejectionReason =
  | 'invented_evidence'
  | 'deleted_evidence'
  | 'evidence_not_exposed'
  | 'unsupported_evidence_quote'
  | 'unsupported_statement_clause'
  | 'evidence_out_of_scope'
  | 'no_evidence'
  | 'missing_target'
  | 'target_not_found'
  | 'owner_not_found'
  | 'invalid_review_at'
  | 'malformed_proposal'
  | 'below_minimum_confidence'
  | 'below_minimum_importance'
  | 'transient_memory'
  | 'duplicate_memory'
  | 'repository_error';

export interface ProposalOutcome {
  /** Position of the proposal in the input batch. */
  index: number;
  action: MemoryAction;
  accepted: boolean;
  /** New id (create/supersede) or existing id (others) when applied. */
  memoryId?: string;
  /** Rejection code when not accepted. */
  reason?: ProposalRejectionReason;
  /** Human-readable detail for auditing (never includes message content). */
  detail?: string;
  evidenceMessageIds: string[];
}

export interface ApplyMemoryProposalsResult {
  applied: ProposalOutcome[];
  rejected: ProposalOutcome[];
  total: number;
}

export interface ApplyMemoryProposalsDeps {
  db: DatabaseSync;
  /** Run retrieval ceiling; passed through to the repository for scope checks. */
  grant: RetrievalGrant;
  guildId: string;
  /** Run id recorded as the creator of created/superseded memories. */
  runId: string;
  now: number;
  /**
   * Channels whose messages were exposed to the model this run: the episode's
   * conversation channel (always in the payload) plus every channel surfaced by
   * a retrieval tool (run provenance). A cited message in any other channel is
   * rejected — the model cannot ground a memory on a message it never saw.
   */
  exposedChannelIds: ReadonlySet<string>;
  /** Exact messages exposed in the initial payload or retrieval tools. */
  exposedMessageIds: ReadonlySet<string>;
  /** Exact memory IDs exposed through the initial payload or retrieval tools. */
  exposedMemoryIds: ReadonlySet<string>;
  /** Host-configured floor for new or mutated durable memory (default 0). */
  minimumConfidence?: number;
  /** Host-configured importance floor for creates/supersedes (default 0). */
  minimumImportance?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Default evidence stance the host assigns per action (the model does not choose it). */
const ACTION_EVIDENCE_STANCE: Record<MemoryAction, EvidenceStance> = {
  create: 'origin',
  confirm: 'supports',
  update: 'updates',
  supersede: 'updates',
  resolve: 'resolves',
  invalidate: 'contradicts',
};

const ACTIONS: readonly MemoryAction[] = [
  'create',
  'confirm',
  'update',
  'supersede',
  'resolve',
  'invalidate',
];

interface EvidenceMeta {
  exists: boolean;
  deleted: boolean;
  channelId: string | null;
  content: string | null;
}

/**
 * A restricted provenance anchor is satisfied only by cited evidence that is
 * itself currently restricted and normalizes to that same anchor. An org
 * parent may be the canonical key for an explicitly restricted thread, but its
 * org messages cannot stand in for restricted evidence from that family.
 */
function hasRestrictedCitationForAnchor(
  db: DatabaseSync,
  citedChannelIds: ReadonlySet<string>,
  requiredAnchor: string,
): boolean {
  for (const channelId of citedChannelIds) {
    const channel = getChannel(db, channelId);
    if (channel?.visibility_class !== 'restricted') continue;
    const citedAnchor = channel.is_thread === 1
      ? channel.parent_id ?? channel.id
      : channel.id;
    if (citedAnchor === requiredAnchor) return true;
  }
  return false;
}

/**
 * Apply an accepted batch of agent memory proposals through the memory
 * repository, validating each independently. Accepted proposals mutate memory;
 * rejected proposals are retained with an auditable reason and never throw. The
 * function is synchronous because every repository mutation is transactional and
 * synchronous.
 */
export function applyMemoryProposals(
  deps: ApplyMemoryProposalsDeps,
  proposals: readonly AgentMemoryProposal[],
): ApplyMemoryProposalsResult {
  const applied: ProposalOutcome[] = [];
  const rejected: ProposalOutcome[] = [];

  // Batch-load the channel/deleted state of every cited evidence message so the
  // exposure and existence checks share one lookup. Per-id query keeps the
  // prepared-statement cache stable regardless of batch size.
  const evidenceMeta = loadEvidenceMeta(deps.db, proposals);

  const acceptedCanonical: AgentMemoryProposal[] = [];
  proposals.forEach((proposal, index) => {
    const overlap = findBatchOverlap(proposal, acceptedCanonical);
    const outcome = overlap && !hasIndependentJustification(proposal)
      ? reject({ index, action: proposal.action, accepted: false, evidenceMessageIds: proposal.evidenceMessageIds ?? [] },
        'duplicate_memory', `overlaps proposal ${overlap.index}; consolidate into one canonical memory or justify independence`)
      : applyOne(deps, proposal, index, evidenceMeta);
    if (outcome.accepted) applied.push(outcome);
    else rejected.push(outcome);
    if (outcome.accepted && (proposal.action === 'create' || proposal.action === 'supersede')) {
      acceptedCanonical.push(proposal);
    }
  });

  if (rejected.length > 0) {
    deps.logger?.info(
      { applied: applied.length, rejected: rejected.length, total: proposals.length },
      'memory-policy: batch applied with rejections',
    );
  }

  return { applied, rejected, total: proposals.length };
}

function applyOne(
  deps: ApplyMemoryProposalsDeps,
  proposal: AgentMemoryProposal,
  index: number,
  evidenceMeta: Map<string, EvidenceMeta>,
): ProposalOutcome {
  const base: ProposalOutcome = {
    index,
    action: proposal.action,
    accepted: false,
    evidenceMessageIds: proposal.evidenceMessageIds ?? [],
  };

  // ---- Structural validation (defense in depth; the proposal is JSON) -------
  if (!ACTIONS.includes(proposal.action)) {
    return reject(base, 'malformed_proposal', `unknown action: ${String(proposal.action)}`);
  }
  if (
    typeof proposal.confidence !== 'number' ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    return reject(base, 'malformed_proposal', 'confidence must be a number in [0, 1]');
  }
  if (!['transient', 'project', 'organizational'].includes(proposal.durability)) {
    return reject(base, 'malformed_proposal', 'durability must be transient, project, or organizational');
  }
  if (typeof proposal.durabilityReason !== 'string' || proposal.durabilityReason.trim() === '') {
    return reject(base, 'malformed_proposal', 'durabilityReason is required');
  }
  if (proposal.confidence < (deps.minimumConfidence ?? 0)) {
    return reject(base, 'below_minimum_confidence', 'confidence is below the configured durable-memory minimum');
  }
  if (
    typeof proposal.importance !== 'number' ||
    proposal.importance < 0 ||
    proposal.importance > 1
  ) {
    return reject(base, 'malformed_proposal', 'importance must be a number in [0, 1]');
  }
  if (!Array.isArray(proposal.evidenceMessageIds) || proposal.evidenceMessageIds.length === 0) {
    return reject(base, 'no_evidence', 'at least one evidence message is required');
  }
  if (!Array.isArray(proposal.evidenceQuotes) || proposal.evidenceQuotes.length === 0) {
    return reject(base, 'malformed_proposal', 'at least one evidence quote is required');
  }

  // ---- Evidence existence / deleted / run-exposure --------------------------
  for (const eid of proposal.evidenceMessageIds) {
    const meta = evidenceMeta.get(eid);
    if (!meta || !meta.exists) {
      return reject(base, 'invented_evidence', `cited message does not exist: ${eid}`);
    }
    if (meta.deleted) {
      return reject(base, 'deleted_evidence', `cited message is deleted: ${eid}`);
    }
    if (meta.channelId === null || !deps.exposedChannelIds.has(meta.channelId)) {
      return reject(
        base,
        'evidence_not_exposed',
        `cited message channel was not exposed this run: ${eid}`,
      );
    }
    if (!deps.exposedMessageIds.has(eid)) {
      return reject(base, 'evidence_not_exposed', `cited message was not exposed this run: ${eid}`);
    }
  }

  const citedIds = new Set(proposal.evidenceMessageIds);
  for (const evidenceQuote of proposal.evidenceQuotes) {
    if (!evidenceQuote || typeof evidenceQuote.messageId !== 'string' || typeof evidenceQuote.quote !== 'string') {
      return reject(base, 'malformed_proposal', 'evidenceQuotes must contain messageId and quote strings');
    }
    if (!citedIds.has(evidenceQuote.messageId)) {
      return reject(base, 'unsupported_evidence_quote', `quote references uncited message: ${evidenceQuote.messageId}`);
    }
    const content = evidenceMeta.get(evidenceQuote.messageId)?.content;
    if (!content || !normalizedText(content).includes(normalizedText(evidenceQuote.quote))) {
      return reject(base, 'unsupported_evidence_quote', `quote is not present in cited message: ${evidenceQuote.messageId}`);
    }
  }
  for (const evidenceId of citedIds) {
    if (!proposal.evidenceQuotes.some((q) => q.messageId === evidenceId)) {
      return reject(base, 'unsupported_evidence_quote', `cited message has no supporting quote: ${evidenceId}`);
    }
  }
  if (proposal.action === 'create' || proposal.action === 'supersede') {
    if (proposal.durability === 'transient') {
      return reject(base, 'transient_memory', 'transient context is not durable organizational memory');
    }
    if (proposal.importance < (deps.minimumImportance ?? 0)) {
      return reject(base, 'below_minimum_importance', 'importance is below the configured durable-memory minimum');
    }
  }

  // A memory cannot be broader than any content exposed during the run. Require
  // citations from every restricted provenance anchor. This also prevents an
  // uncited restricted paraphrase from becoming an org memory.
  if (proposal.action === 'create' || proposal.action === 'update' || proposal.action === 'supersede') {
    const citedChannels = new Set(
      proposal.evidenceMessageIds.map((id) => evidenceMeta.get(id)?.channelId).filter((id): id is string => Boolean(id)),
    );
    for (const channelId of deps.exposedChannelIds) {
      const channel = getChannel(deps.db, channelId);
      if (!channel || channel.visibility_class === 'excluded' || channel.visibility_class === 'review_only') {
        return reject(base, 'evidence_out_of_scope', 'run provenance is not safe for durable memory');
      }
      if (channel.visibility_class === 'restricted') {
        const anchor = channel.is_thread === 1 ? channel.parent_id ?? channel.id : channel.id;
        if (!hasRestrictedCitationForAnchor(deps.db, citedChannels, anchor)) {
          return reject(base, 'evidence_out_of_scope', `restricted run provenance lacks cited evidence: ${channelId}`);
        }
      }
    }
    for (const memoryId of deps.exposedMemoryIds ?? []) {
      const memory = getMemoryDetails(deps.db, deps.grant, memoryId);
      if (!memory || memory.scopeType === 'review_only') {
        return reject(base, 'evidence_out_of_scope', 'run memory provenance is not safe for durable memory');
      }
      if (memory.scopeType === 'channel' && memory.scopeKey) {
        if (!hasRestrictedCitationForAnchor(deps.db, citedChannels, memory.scopeKey)) {
          return reject(base, 'evidence_out_of_scope', `restricted memory provenance lacks cited evidence: ${memoryId}`);
        }
      }
    }
  }

  // ---- Lifecycle target existence -------------------------------------------
  const needsTarget = proposal.action !== 'create';
  if (needsTarget) {
    if (!proposal.existingMemoryId) {
      return reject(base, 'missing_target', `${proposal.action} requires existingMemoryId`);
    }
    const target = getMemory(deps.db, proposal.existingMemoryId);
    if (!target) {
      return reject(base, 'target_not_found', `memory does not exist: ${proposal.existingMemoryId}`);
    }
    if (!(deps.exposedMemoryIds ?? new Set<string>()).has(proposal.existingMemoryId) ||
        !getMemoryDetails(deps.db, deps.grant, proposal.existingMemoryId)) {
      return reject(base, 'evidence_out_of_scope', 'target memory was not visible and exposed in this run');
    }
  }

  // ---- Owner existence ------------------------------------------------------
  if (proposal.ownerUserId !== undefined) {
    if (!getUser(deps.db, proposal.ownerUserId)) {
      return reject(base, 'owner_not_found', `owner user does not exist: ${proposal.ownerUserId}`);
    }
  }

  // ---- reviewAt → reviewAfterMs --------------------------------------------
  let reviewAfterMs: number | undefined;
  if (proposal.reviewAt !== undefined) {
    const parsed = Date.parse(proposal.reviewAt);
    if (!Number.isFinite(parsed)) {
      return reject(base, 'invalid_review_at', `reviewAt is not a valid date-time: ${proposal.reviewAt}`);
    }
    reviewAfterMs = parsed;
  }

  if ((proposal.action === 'create' || proposal.action === 'update' || proposal.action === 'supersede') &&
      typeof proposal.statement === 'string' &&
      !statementClausesSupported(proposal.statement, [...citedIds].map((id) => evidenceMeta.get(id)?.content ?? ''))) {
    return reject(base, 'unsupported_statement_clause', 'one or more material statement clauses lack lexical support in cited evidence');
  }

  // ---- Translate to repository input and apply (catch validated failures) --
  const stance = ACTION_EVIDENCE_STANCE[proposal.action];
  const evidence: MemoryEvidenceInput[] = proposal.evidenceMessageIds.map((messageId) => ({
    messageId,
    stance,
  }));

  // The host owns canonicalization. Exact same-type active duplicates are
  // confirmed with the new evidence instead of creating a parallel row. A
  // semantically similar same-type memory backed by substantially overlapping
  // evidence is also canonical across separate runs; historical look-ahead can
  // otherwise surface the same source message in several adjacent episodes.
  if (proposal.action === 'create' && proposal.statement && proposal.type) {
    const evidenceMatch = findCanonicalEvidenceMatch(deps, proposal);
    const duplicates = findDuplicateCandidates(deps.db, deps.grant, {
      statement: proposal.statement,
      type: proposal.type as MemoryType,
    });
    const exact = duplicates.candidates.find((candidate) =>
      candidate.matchKind === 'exact' && candidate.status === 'active');
    const canonicalMemoryId = evidenceMatch ?? exact?.memoryId;
    if (canonicalMemoryId) {
      try {
        confirmMemory(deps.db, deps.grant, {
          memoryId: canonicalMemoryId,
          evidence: proposal.evidenceMessageIds.map((messageId) => ({ messageId, stance: 'supports' })),
          now: deps.now,
        });
        return { ...base, accepted: true, memoryId: canonicalMemoryId };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return reject(base, 'repository_error', detail);
      }
    }
  }

  try {
    const memoryId = applyViaRepository(deps, proposal, evidence, reviewAfterMs);
    return { ...base, accepted: true, memoryId };
  } catch (err) {
    if (err instanceof MemoryValidationError) {
      // The repository is the scope/lifecycle authority; map its message to the
      // out-of-scope code when it names evidence scope, else a generic code.
      const reason: ProposalRejectionReason = /evidence|scope/i.test(err.message)
        ? 'evidence_out_of_scope'
        : 'repository_error';
      return reject(base, reason, err.message);
    }
    // An unexpected error still must not abort the batch or mutate memory.
    const detail = err instanceof Error ? err.message.slice(0, 200) : String(err);
    deps.logger?.warn({ index, action: proposal.action, err: detail }, 'memory-policy: unexpected error applying proposal');
    return reject(base, 'repository_error', `unexpected error: ${detail}`);
  }
}

function applyViaRepository(
  deps: ApplyMemoryProposalsDeps,
  proposal: AgentMemoryProposal,
  evidence: MemoryEvidenceInput[],
  reviewAfterMs: number | undefined,
): string {
  const { db, grant, guildId, runId, now } = deps;
  switch (proposal.action) {
    case 'create':
      return createMemory(db, grant, {
        guildId,
        type: proposal.type as MemoryType,
        statement: proposal.statement ?? '',
        confidence: proposal.confidence,
        importance: proposal.importance,
        ownerUserId: proposal.ownerUserId,
        reviewAfterMs,
        metadata: proposal.metadata,
        evidence,
        createdByRunId: runId,
        now,
      });
    case 'confirm':
      confirmMemory(db, grant, {
        memoryId: proposal.existingMemoryId!,
        evidence,
        now,
      });
      return proposal.existingMemoryId!;
    case 'update':
      updateMemory(db, grant, {
        memoryId: proposal.existingMemoryId!,
        type: proposal.type as MemoryType | undefined,
        statement: proposal.statement,
        confidence: proposal.confidence,
        importance: proposal.importance,
        reviewAfterMs,
        metadata: proposal.metadata,
        evidence,
        now,
      });
      return proposal.existingMemoryId!;
    case 'supersede':
      return supersedeMemory(db, grant, {
        guildId,
        existingMemoryId: proposal.existingMemoryId!,
        type: proposal.type as MemoryType,
        statement: proposal.statement ?? '',
        confidence: proposal.confidence,
        importance: proposal.importance,
        ownerUserId: proposal.ownerUserId,
        reviewAfterMs,
        metadata: proposal.metadata,
        evidence,
        createdByRunId: runId,
        now,
      });
    case 'resolve':
      resolveMemory(db, grant, { memoryId: proposal.existingMemoryId!, evidence, now });
      return proposal.existingMemoryId!;
    case 'invalidate':
      invalidateMemory(db, grant, { memoryId: proposal.existingMemoryId!, evidence, now });
      return proposal.existingMemoryId!;
  }
}

function reject(
  base: ProposalOutcome,
  reason: ProposalRejectionReason,
  detail: string,
): ProposalOutcome {
  return { ...base, accepted: false, reason, detail };
}

/**
 * Load existence/deleted/channel metadata for every cited evidence message id
 * across the batch. A missing row means the id was invented.
 */
function loadEvidenceMeta(
  db: DatabaseSync,
  proposals: readonly AgentMemoryProposal[],
): Map<string, EvidenceMeta> {
  const ids = new Set<string>();
  for (const p of proposals) {
    if (Array.isArray(p.evidenceMessageIds)) {
      for (const id of p.evidenceMessageIds) ids.add(id);
    }
  }
  const out = new Map<string, EvidenceMeta>();
  const stmt = prepareCached(
    db,
    'memory_policy.evidence_meta',
    'SELECT id, channel_id, deleted_at_ms, content FROM messages WHERE id = ?',
  );
  for (const id of ids) {
    const row = stmt.get(id) as { id: string; channel_id: string | null; deleted_at_ms: number | null; content: string | null } | undefined;
    if (row) {
      out.set(id, { exists: true, deleted: row.deleted_at_ms !== null, channelId: row.channel_id, content: row.content });
    } else {
      // Existence is authoritative via getMessage shape; keep an explicit entry
      // so the existence check distinguishes "absent" from "not yet queried".
      out.set(id, { exists: false, deleted: false, channelId: null, content: null });
    }
  }
  return out;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

const SUPPORT_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'because', 'before', 'being', 'but', 'can',
  'could', 'for', 'from', 'has', 'have', 'help', 'into', 'its', 'our', 'should', 'that',
  'the', 'their', 'this', 'those', 'use', 'using', 'was', 'were', 'will', 'with', 'would',
]);

function supportTerms(value: string): Set<string> {
  return new Set(normalizedText(value).match(/[a-z0-9_-]{3,}/g)
    ?.filter((term) => !SUPPORT_STOP_WORDS.has(term)) ?? []);
}

/**
 * Find an already-active canonical record from the same evidence-backed claim.
 * Evidence overlap alone is insufficient because one message may support more
 * than one memory. Same type plus evidence and lexical containment keeps this
 * deterministic and conservative.
 */
function findCanonicalEvidenceMatch(
  deps: ApplyMemoryProposalsDeps,
  proposal: AgentMemoryProposal,
): string | undefined {
  if (!proposal.statement || !proposal.type || proposal.evidenceMessageIds.length === 0) return undefined;
  const evidenceIds = [...new Set(proposal.evidenceMessageIds)];
  const placeholders = evidenceIds.map(() => '?').join(',');
  const rows = deps.db.prepare(`
    SELECT mem.id, mem.statement, COUNT(DISTINCT me.message_id) AS overlap_count,
           (SELECT COUNT(*) FROM memory_evidence all_me WHERE all_me.memory_id=mem.id) AS evidence_count
      FROM memories mem
      JOIN memory_evidence me ON me.memory_id=mem.id
     WHERE mem.guild_id=? AND mem.status='active' AND mem.type=?
       AND me.message_id IN (${placeholders})
     GROUP BY mem.id, mem.statement
  `).all(deps.guildId, proposal.type, ...evidenceIds) as Array<{
    id: string;
    statement: string;
    overlap_count: number;
    evidence_count: number;
  }>;

  const proposedTerms = supportTerms(proposal.statement);
  let best: { id: string; score: number } | undefined;
  for (const row of rows) {
    if (!getMemoryDetails(deps.db, deps.grant, row.id)) continue;
    const overlap = Number(row.overlap_count);
    const existingEvidence = Math.max(1, Number(row.evidence_count));
    const evidenceContainment = overlap / Math.min(evidenceIds.length, existingEvidence);
    if (evidenceContainment < 0.5) continue;
    const existingTerms = supportTerms(row.statement);
    const denominator = Math.min(proposedTerms.size, existingTerms.size);
    if (denominator === 0) continue;
    let shared = 0;
    for (const term of proposedTerms) if (existingTerms.has(term)) shared += 1;
    const lexicalContainment = shared / denominator;
    if (lexicalContainment < 0.6) continue;
    const score = evidenceContainment * 0.55 + lexicalContainment * 0.45;
    if (!best || score > best.score) best = { id: row.id, score };
  }
  return best?.id;
}

function statementClausesSupported(statement: string, evidenceContents: readonly string[]): boolean {
  const evidenceTerms = supportTerms(evidenceContents.join(' '));
  const clauses = statement.split(/[,;]|\b(?:and|but|while|because|so that|to help)\b/i);
  return clauses.every((clause) => {
    const terms = supportTerms(clause);
    if (terms.size < 2) return true;
    const overlap = [...terms].filter((term) => evidenceTerms.has(term)).length;
    return overlap >= Math.max(1, Math.ceil(terms.size * 0.25));
  });
}

function hasIndependentJustification(proposal: AgentMemoryProposal): boolean {
  return typeof proposal.independentReason === 'string' && proposal.independentReason.trim().length >= 20;
}

function findBatchOverlap(
  proposal: AgentMemoryProposal,
  accepted: readonly AgentMemoryProposal[],
): { index: number } | undefined {
  if (proposal.action !== 'create' && proposal.action !== 'supersede') return undefined;
  const evidence = new Set(proposal.evidenceMessageIds ?? []);
  for (let index = 0; index < accepted.length; index += 1) {
    const candidate = accepted[index]!;
    const sharesEvidence = candidate.evidenceMessageIds.some((id) => evidence.has(id));
    if (sharesEvidence) return { index };
  }
  return undefined;
}
