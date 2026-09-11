import { type DatabaseSync } from '../db/database.js';
import type { SQLOutputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import { enqueue } from '../jobs/queue.js';
import { recomputeMemoryScopes } from './search.js';
import type { MemoryStatus, MemoryType } from './repository.js';

/**
 * Due-memory selection for scheduled review (Sections 12.4, 20).
 *
 * A memory is reviewable when it is `active` and carries a `review_after_ms` that
 * has elapsed. Predictions and assumptions usually carry review dates, but any
 * active memory with a due review date is eligible — the criterion is the due
 * date, not the type. Selection returns the recomputed effective scope and
 * evidence density for each item so the review prompt can present material the
 * secure review channel is entitled to see (Section 12.4).
 *
 * Scheduling enqueues a `review_due_memories` job under a stable unique key, so
 * repeated scheduler ticks collapse onto one active job instead of stacking
 * duplicate work (the jobs partial unique index, Section 10).
 */

export interface DueMemoryCandidate {
  memoryId: string;
  type: MemoryType;
  statement: string;
  status: MemoryStatus;
  confidence: number;
  importance: number;
  reviewAfterMs: number;
  lastConfirmedAtMs: number;
  evidenceCount: number;
  scopeType: string;
  scopeKey: string | null;
}

export interface SelectDueMemoriesOptions {
  now: number;
  /** Upper bound on items returned (default 50). */
  limit?: number;
  /**
   * Staleness horizon in milliseconds (Section 12.4). A memory whose review date
   * and newest evidence message are both older than this is not selected; the
   * periodic maintenance sweep expires it instead. The newest evidence message is
   * the human-activity anchor: extraction or re-extraction of an old conversation
   * does not refresh it, while any evidence-backed confirmation does. Zero or
   * absent disables the horizon.
   */
  stalenessHorizonMs?: number;
}

/** Threshold timestamp for the staleness horizon; `-1` (matches nothing) when disabled. */
function staleCutoff(options: SelectDueMemoriesOptions): number {
  const horizon = options.stalenessHorizonMs ?? 0;
  return horizon > 0 ? options.now - horizon : -1;
}

export const DEFAULT_DUE_LIMIT = 50;
export const DUE_REVIEW_UNIQUE_KEY = 'due-review';

/** Fair bounded dispatcher scan. Active cohort subjects remain owned by their job. */
export function selectDueMemoriesForDispatch(
  db: DatabaseSync,
  options: SelectDueMemoriesOptions,
): DueMemoryCandidate[] {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_DUE_LIMIT, DEFAULT_DUE_LIMIT));
  const rows = prepareCached(
    db,
    'memory.due_dispatch',
    `SELECT mem.id, mem.type, mem.statement, mem.status, mem.confidence, mem.importance,
            mem.review_after_ms, mem.last_confirmed_at_ms,
            (SELECT COUNT(*) FROM memory_evidence me WHERE me.memory_id = mem.id) AS evidence_count
       FROM memories mem
       LEFT JOIN scheduled_review_dispatch_state state ON state.memory_id = mem.id
      WHERE mem.status = 'active'
        AND mem.review_after_ms IS NOT NULL
        AND mem.review_after_ms <= ?
        AND NOT (mem.review_after_ms <= ? AND COALESCE((
          SELECT MAX(msg.created_at_ms) FROM memory_evidence me2
            JOIN messages msg ON msg.id = me2.message_id
           WHERE me2.memory_id = mem.id), 0) <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_review_cohort_subject_leases lease
           JOIN jobs job ON job.id = lease.job_id
          WHERE lease.memory_id = mem.id AND job.status IN ('queued', 'running')
        )
      ORDER BY COALESCE(state.last_considered_at_ms, 0), mem.review_after_ms, mem.id
      LIMIT ?`,
  ).all(options.now, staleCutoff(options), staleCutoff(options), limit) as Array<Record<string, SQLOutputValue>>;
  if (rows.length === 0) return [];
  const scopes = recomputeMemoryScopes(db, rows.map((row) => String(row.id)));
  return rows.map((row) => {
    const memoryId = String(row.id);
    const scope = scopes.get(memoryId);
    return {
      memoryId,
      type: String(row.type) as MemoryType,
      statement: String(row.statement),
      status: String(row.status) as MemoryStatus,
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      reviewAfterMs: Number(row.review_after_ms),
      lastConfirmedAtMs: Number(row.last_confirmed_at_ms),
      evidenceCount: Number(row.evidence_count),
      scopeType: scope?.scopeType ?? 'review_only',
      scopeKey: scope?.scopeKey ?? null,
    };
  });
}

/**
 * Active memories whose `review_after_ms` has elapsed, most-overdue first, with
 * recomputed effective scope and evidence density. Non-active memories, items
 * without a review date, and items not yet due are excluded.
 */
export function selectDueMemories(
  db: DatabaseSync,
  options: SelectDueMemoriesOptions,
): DueMemoryCandidate[] {
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_DUE_LIMIT, 200));
  const rows = prepareCached(
    db,
    'memory.due',
    `SELECT mem.id, mem.type, mem.statement, mem.status, mem.confidence, mem.importance,
            mem.review_after_ms, mem.last_confirmed_at_ms,
            (SELECT COUNT(*) FROM memory_evidence me WHERE me.memory_id = mem.id) AS evidence_count
       FROM memories mem
      WHERE mem.status = 'active'
        AND mem.review_after_ms IS NOT NULL
        AND mem.review_after_ms <= ?
        AND NOT (mem.review_after_ms <= ? AND COALESCE((
          SELECT MAX(msg.created_at_ms) FROM memory_evidence me2
            JOIN messages msg ON msg.id = me2.message_id
           WHERE me2.memory_id = mem.id), 0) <= ?)
      ORDER BY mem.review_after_ms ASC
      LIMIT ?`,
  ).all(options.now, staleCutoff(options), staleCutoff(options), limit) as Array<Record<string, SQLOutputValue>>;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.id));
  const scopes = recomputeMemoryScopes(db, ids);

  return rows.map((r) => {
    const id = String(r.id);
    const scope = scopes.get(id);
    return {
      memoryId: id,
      type: String(r.type) as MemoryType,
      statement: String(r.statement),
      status: String(r.status) as MemoryStatus,
      confidence: Number(r.confidence),
      importance: Number(r.importance),
      reviewAfterMs: Number(r.review_after_ms),
      lastConfirmedAtMs: Number(r.last_confirmed_at_ms),
      evidenceCount: Number(r.evidence_count),
      scopeType: scope ? scope.scopeType : 'review_only',
      scopeKey: scope && scope.scopeKey !== undefined ? scope.scopeKey : null,
    };
  });
}

export interface ScheduleDueReviewOptions {
  db: DatabaseSync;
  now: number;
  /** Unique key collapsing concurrent review jobs (default `due-review`). */
  uniqueKey?: string;
  /** Max due items to consider before enqueuing (default 50). */
  limit?: number;
}

export interface ScheduleDueReviewResult {
  /** Number of due memories found. */
  dueCount: number;
  /** True if a review job was enqueued (false when none are due or a job is already active). */
  enqueued: boolean;
  /** Job id, when one was enqueued. */
  jobId?: string;
}

/**
 * Enqueue a `review_due_memories` job for due material, if any exists and no
 * active review job is already queued/running. Repeated ticks with the same
 * unique key collapse to one active job (no duplicate concurrent work). When no
 * memory is due, nothing is enqueued.
 */
export function scheduleDueReview(db: DatabaseSync, options: ScheduleDueReviewOptions): ScheduleDueReviewResult {
  const due = selectDueMemories(db, { now: options.now, limit: options.limit });
  if (due.length === 0) {
    return { dueCount: 0, enqueued: false };
  }
  const result = enqueue(db, {
    type: 'review_due_memories',
    payload: { sinceMs: options.now },
    uniqueKey: options.uniqueKey ?? DUE_REVIEW_UNIQUE_KEY,
    now: options.now,
  });
  return {
    dueCount: due.length,
    enqueued: result.enqueued,
    jobId: result.enqueued ? result.id : undefined,
  };
}
