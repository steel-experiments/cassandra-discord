import { createHash } from 'node:crypto';
import { type DatabaseSync } from '../db/database.js';
import { getProposal, type ProposalStatus } from '../db/repositories/proposals.js';
import { prepareCached } from '../db/repositories/util.js';
import { fingerprintExposedMemory } from '../agent/run-context.js';
import { getMemory } from './repository.js';

/** Default quiet period after a sent or dismissed reminder about unchanged memory. */
export const DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScheduledSubjectSnapshot {
  memoryId: string;
  memoryFingerprint: string;
}

export interface ResolveScheduledSubjectsResult {
  subjects: ScheduledSubjectSnapshot[];
  blockingReasons: string[];
}

/**
 * Resolve model-declared scheduled subjects through host-owned due-memory and
 * evidence relationships. A recommended notification must cite at least one
 * stored evidence row for every subject it names.
 */
export function resolveScheduledSubjects(
  db: DatabaseSync,
  input: {
    dueMemoryIds: ReadonlySet<string>;
    proposedSubjectMemoryIds: readonly unknown[];
    citedMessageIds: ReadonlySet<string>;
    now: number;
  },
): ResolveScheduledSubjectsResult {
  const blockingReasons: string[] = [];
  const subjects: ScheduledSubjectSnapshot[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of input.proposedSubjectMemoryIds) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      blockingReasons.push('notification subject identifiers are malformed');
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }

  if (ids.length === 0) {
    blockingReasons.push('notification has no due-memory subject');
  }

  const evidence = prepareCached(
    db,
    'scheduled_notifications.subject_evidence',
    'SELECT message_id FROM memory_evidence WHERE memory_id = ?',
  );
  for (const memoryId of ids) {
    if (!input.dueMemoryIds.has(memoryId)) {
      blockingReasons.push('notification subject was not due and exposed in this run');
      continue;
    }
    const memory = getMemory(db, memoryId);
    if (
      !memory
      || memory.status !== 'active'
      || memory.review_after_ms === null
      || memory.review_after_ms > input.now
    ) {
      blockingReasons.push('notification subject is no longer due');
      continue;
    }
    const hasCitedEvidence = (evidence.all(memoryId) as Array<{ message_id: string }>).some(
      (row) => input.citedMessageIds.has(row.message_id),
    );
    if (!hasCitedEvidence) {
      blockingReasons.push('notification subject is not supported by its cited evidence');
      continue;
    }
    const memoryFingerprint = fingerprintExposedMemory(db, memoryId);
    if (!memoryFingerprint) {
      blockingReasons.push('notification subject is no longer available');
      continue;
    }
    subjects.push({ memoryId, memoryFingerprint });
  }

  return {
    subjects,
    blockingReasons: [...new Set(blockingReasons)],
  };
}

/** Stable content-free key for the exact scheduled subject set. */
export function scheduledTopicKey(subjects: readonly ScheduledSubjectSnapshot[]): string | null {
  const ids = [...new Set(subjects.map((subject) => subject.memoryId))].sort();
  if (ids.length === 0) return null;
  return `scheduled:${createHash('sha256').update(ids.join('\n')).digest('hex')}`;
}

/** Persist proposal subjects. The caller owns the proposal+subject transaction. */
export function insertScheduledProposalSubjects(
  db: DatabaseSync,
  proposalId: string,
  subjects: readonly ScheduledSubjectSnapshot[],
  now: number,
): void {
  const insert = prepareCached(
    db,
    'scheduled_notifications.subject_insert',
    `INSERT INTO scheduled_proposal_subjects
       (proposal_id, memory_id, memory_fingerprint, created_at_ms)
     VALUES (?, ?, ?, ?)`,
  );
  for (const subject of subjects) {
    insert.run(proposalId, subject.memoryId, subject.memoryFingerprint, now);
  }
}

/** Load persisted subjects, falling back to pre-migration scheduled proposals. */
export function getScheduledProposalSubjects(
  db: DatabaseSync,
  proposalId: string,
): ScheduledSubjectSnapshot[] {
  const stored = prepareCached(
    db,
    'scheduled_notifications.subjects_get',
    `SELECT memory_id, memory_fingerprint
       FROM scheduled_proposal_subjects
      WHERE proposal_id = ?
      ORDER BY memory_id`,
  ).all(proposalId) as Array<{ memory_id: string; memory_fingerprint: string }>;
  if (stored.length > 0) {
    return stored.map((row) => ({
      memoryId: row.memory_id,
      memoryFingerprint: row.memory_fingerprint,
    }));
  }
  return deriveLegacySubjects(db, proposalId);
}

interface PriorScheduledProposal {
  id: string;
  status: ProposalStatus;
  expires_at_ms: number | null;
  reviewed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  outbox_status: string | null;
  sent_at_ms: number | null;
}

export type ScheduledSubjectBlock =
  | { blocked: false }
  | {
      blocked: true;
      reason:
        | 'scheduled subject already has an actionable proposal'
        | 'scheduled subject already has a delivery in progress'
        | 'scheduled subject is inside the reminder interval'
        | 'scheduled subject is no longer due'
        | 'scheduled subject changed after proposal creation';
      priorProposalId: string;
    };

/**
 * Check prior scheduled proposals for any overlapping subject. Pending and
 * in-flight delivery always block. Sent/dismissed rows block only while the
 * subject fingerprint is unchanged and the reminder interval has not elapsed.
 */
export function findScheduledSubjectBlock(
  db: DatabaseSync,
  input: {
    subjects: readonly ScheduledSubjectSnapshot[];
    now: number;
    reminderIntervalMs?: number;
    candidateProposalId?: string;
    earlierOnly?: boolean;
  },
): ScheduledSubjectBlock {
  if (input.subjects.length === 0) return { blocked: false };
  const reminderIntervalMs = input.reminderIntervalMs ?? DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS;
  const candidate = input.candidateProposalId
    ? getProposal(db, input.candidateProposalId)
    : undefined;
  const current = new Map(input.subjects.map((subject) => [subject.memoryId, subject.memoryFingerprint]));
  const cutoff = input.now - reminderIntervalMs;
  const subjectPlaceholders = [...current.keys()].map(() => '?').join(', ');
  const rows = prepareCached(
    db,
    `scheduled_notifications.prior_candidates:${current.size}`,
    `SELECT DISTINCT p.id, p.status, p.expires_at_ms, p.reviewed_at_ms, p.created_at_ms,
            p.updated_at_ms, o.status AS outbox_status, o.sent_at_ms
       FROM proposals p
       JOIN agent_runs ar ON ar.id = p.run_id AND ar.run_type = 'scheduled_review'
       LEFT JOIN outbox o ON o.proposal_id = p.id
       LEFT JOIN scheduled_proposal_subjects s ON s.proposal_id = p.id
      WHERE p.id <> COALESCE(?, '')
        AND (
          p.status IN ('pending_review', 'approved')
          OR (p.status IN ('sent', 'dismissed')
              AND COALESCE(o.sent_at_ms, p.reviewed_at_ms, p.updated_at_ms) > ?)
        )
        AND (
          s.memory_id IN (${subjectPlaceholders})
          OR NOT EXISTS (
            SELECT 1 FROM scheduled_proposal_subjects existing
             WHERE existing.proposal_id = p.id
          )
        )
      ORDER BY p.created_at_ms ASC, p.id ASC`,
  ).all(input.candidateProposalId ?? null, cutoff, ...current.keys()) as unknown as PriorScheduledProposal[];

  for (const prior of rows) {
    if (input.earlierOnly && candidate && !isEarlier(prior, candidate)) continue;
    const priorSubjects = getScheduledProposalSubjects(db, prior.id);
    const overlaps = priorSubjects.filter((subject) => current.has(subject.memoryId));
    if (overlaps.length === 0) continue;
    const hasUnchangedOverlap = overlaps.some(
      (subject) => subject.memoryFingerprint === current.get(subject.memoryId),
    );

    if (
      prior.status === 'pending_review'
      && (prior.expires_at_ms === null || prior.expires_at_ms >= input.now)
      && hasUnchangedOverlap
    ) {
      return {
        blocked: true,
        reason: 'scheduled subject already has an actionable proposal',
        priorProposalId: prior.id,
      };
    }

    if (
      prior.status === 'approved'
      && (prior.outbox_status === null || prior.outbox_status === 'queued' || prior.outbox_status === 'sending')
    ) {
      return {
        blocked: true,
        reason: 'scheduled subject already has a delivery in progress',
        priorProposalId: prior.id,
      };
    }

    if (prior.status === 'sent' || prior.status === 'dismissed') {
      const relevantAt = prior.sent_at_ms ?? prior.reviewed_at_ms ?? prior.updated_at_ms;
      if (hasUnchangedOverlap && relevantAt > cutoff) {
        return {
          blocked: true,
          reason: 'scheduled subject is inside the reminder interval',
          priorProposalId: prior.id,
        };
      }
    }
  }

  return { blocked: false };
}

/** Atomic approval-time form, restricted to proposals earlier than the candidate. */
export function findScheduledApprovalSubjectBlock(
  db: DatabaseSync,
  proposalId: string,
  now: number,
  reminderIntervalMs = DEFAULT_SCHEDULED_REMINDER_INTERVAL_MS,
): ScheduledSubjectBlock {
  const subjects = getScheduledProposalSubjects(db, proposalId);
  for (const subject of subjects) {
    const memory = getMemory(db, subject.memoryId);
    if (
      !memory
      || memory.status !== 'active'
      || memory.review_after_ms === null
      || memory.review_after_ms > now
    ) {
      return {
        blocked: true,
        reason: 'scheduled subject is no longer due',
        priorProposalId: proposalId,
      };
    }
    const currentFingerprint = fingerprintExposedMemory(db, subject.memoryId);
    if (!currentFingerprint || currentFingerprint !== subject.memoryFingerprint) {
      return {
        blocked: true,
        reason: 'scheduled subject changed after proposal creation',
        priorProposalId: proposalId,
      };
    }
  }
  return findScheduledSubjectBlock(db, {
    subjects,
    now,
    reminderIntervalMs,
    candidateProposalId: proposalId,
    earlierOnly: true,
  });
}

function isEarlier(prior: PriorScheduledProposal, candidate: { createdAtMs: number; id: string }): boolean {
  return prior.created_at_ms < candidate.createdAtMs
    || (prior.created_at_ms === candidate.createdAtMs && prior.id < candidate.id);
}

/** Infer subjects for proposals created before migration 027. */
function deriveLegacySubjects(db: DatabaseSync, proposalId: string): ScheduledSubjectSnapshot[] {
  const proposal = getProposal(db, proposalId);
  if (!proposal || proposal.evidenceMessageIds.length === 0) return [];
  const run = prepareCached(
    db,
    'scheduled_notifications.legacy_run',
    `SELECT run_type, retrieval_provenance_json
       FROM agent_runs
      WHERE id = ?`,
  ).get(proposal.runId) as { run_type: string; retrieval_provenance_json: string } | undefined;
  if (!run || run.run_type !== 'scheduled_review') return [];

  let memoryIds: string[] = [];
  try {
    const parsed = JSON.parse(run.retrieval_provenance_json) as { memoryIds?: unknown };
    if (Array.isArray(parsed.memoryIds)) {
      memoryIds = parsed.memoryIds.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    return [];
  }

  const cited = new Set(proposal.evidenceMessageIds);
  const evidence = prepareCached(
    db,
    'scheduled_notifications.legacy_evidence',
    'SELECT message_id FROM memory_evidence WHERE memory_id = ?',
  );
  const out: ScheduledSubjectSnapshot[] = [];
  for (const memoryId of new Set(memoryIds)) {
    const overlaps = (evidence.all(memoryId) as Array<{ message_id: string }>).some(
      (row) => cited.has(row.message_id),
    );
    if (!overlaps) continue;
    const memoryFingerprint = fingerprintExposedMemory(db, memoryId);
    if (memoryFingerprint) out.push({ memoryId, memoryFingerprint });
  }
  return out.sort((a, b) => a.memoryId.localeCompare(b.memoryId));
}
