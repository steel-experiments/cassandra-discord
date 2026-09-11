import { randomUUID } from 'node:crypto';
import { type DatabaseSync, transactionImmediate } from '../db/database.js';
import type { SQLInputValue } from 'node:sqlite';
import { prepareCached } from '../db/repositories/util.js';
import {
  classifyError,
  PermanentJobError,
  TransientJobError,
} from './errors.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRIORITY,
  validateJobPayload,
  type EnqueueInput,
  type EnqueueResult,
  type JobRow,
  type JobStatus,
  type JobType,
  type JobTypePayloadMap,
} from './types.js';

export { PermanentJobError, TransientJobError };

/**
 * The durable job queue (Section 10). No external queue; state lives in the
 * `jobs` table. Active uniqueness is enforced by the partial index
 * `jobs_active_unique_idx`, so duplicate enqueue of the same type+key collapses
 * to one row while completed/cancelled jobs are free to re-enqueue.
 */

const TERMINAL_STATUSES: JobStatus[] = ['succeeded', 'failed', 'cancelled'];

// ---- Enqueue ---------------------------------------------------------

const ENQUEUE_SQL = `
  INSERT INTO jobs (id, type, unique_key, payload_json, status, priority,
                    run_after_ms, attempts, max_attempts, created_at_ms, updated_at_ms)
  VALUES (@id, @type, @unique_key, @payload_json, 'queued', @priority,
          @run_after_ms, 0, @max_attempts, @now, @now)
  ON CONFLICT(type, unique_key)
    WHERE unique_key IS NOT NULL AND status IN ('queued', 'running')
    DO NOTHING
`;

/** Enqueue a job. Collapses to a no-op when a duplicate active unique job exists. */
export function enqueue<T extends JobType>(
  db: DatabaseSync,
  input: EnqueueInput<T>,
): EnqueueResult {
  validateJobPayload(input.type, input.payload);
  const id = randomUUID();
  const uniqueKey = input.uniqueKey ?? null;
  const priority = input.priority ?? DEFAULT_PRIORITY;
  const runAfterMs = input.runAfterMs ?? input.now;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const stmt = prepareCached(db, 'jobs.enqueue', ENQUEUE_SQL);
  const changes = Number(
    stmt.run({
      id,
      type: input.type,
      unique_key: uniqueKey,
      payload_json: JSON.stringify(input.payload),
      priority,
      run_after_ms: runAfterMs,
      max_attempts: maxAttempts,
      now: input.now,
    }).changes,
  );
  return { id, enqueued: changes > 0 };
}

/** Move an existing queued unique job to a new deadline. Running jobs are not changed. */
export function rescheduleQueuedUniqueJob(
  db: DatabaseSync,
  type: JobType,
  uniqueKey: string,
  runAfterMs: number,
  now: number,
): boolean {
  return Number(
    prepareCached(
      db,
      'jobs.reschedule_queued_unique',
      `UPDATE jobs
          SET run_after_ms = ?, updated_at_ms = ?
        WHERE type = ? AND unique_key = ? AND status = 'queued'`,
    ).run(runAfterMs, now, type, uniqueKey).changes,
  ) > 0;
}

export function getJob(db: DatabaseSync, id: string): JobRow | undefined {
  return prepareCached(db, 'jobs.get', 'SELECT * FROM jobs WHERE id = ?').get(id) as
    | JobRow
    | undefined;
}

/**
 * Find the active (queued or running) job for a type+uniqueKey, if any. Used by
 * callers that need the surviving job id after a collapsed enqueue.
 */
export function findActiveUniqueJob(
  db: DatabaseSync,
  type: JobType,
  uniqueKey: string,
): JobRow | undefined {
  return prepareCached(
    db,
    'jobs.find_active_unique',
    `SELECT * FROM jobs
     WHERE type = ? AND unique_key = ? AND status IN ('queued', 'running')
     LIMIT 1`,
  ).get(type, uniqueKey) as JobRow | undefined;
}

/** Count jobs by status (used by tests and the status endpoint). */
export function countJobsByStatus(db: DatabaseSync, status: JobStatus): number {
  const row = prepareCached(
    db,
    'jobs.count_status',
    'SELECT COUNT(*) AS n FROM jobs WHERE status = ?',
  ).get(status) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---- Leasing ---------------------------------------------------------

export interface ClaimOptions {
  owner: string;
  now: number;
  /** Lease duration in ms; the job returns to the queue after it elapses. */
  leaseMs: number;
  /** Restrict the claim to a single job type. */
  type?: JobType;
  /** Claim any type EXCEPT these (used to drain jobs with no registered handler). */
  excludeTypes?: JobType[];
}

/**
 * Claim the highest-priority due job in a short `BEGIN IMMEDIATE` transaction
 * (Section 10). Increments the attempt count and sets the lease. Optional
 * `type` / `excludeTypes` filters scope the claim. Returns the claimed job, or
 * undefined when nothing matches.
 */
export function claimNextJob(db: DatabaseSync, opts: ClaimOptions): JobRow | undefined {
  const params: Record<string, SQLInputValue> = {
    owner: opts.owner,
    lease_until: opts.now + opts.leaseMs,
    now: opts.now,
  };
  const filters: string[] = [];
  if (opts.type) {
    params.type_filter = opts.type;
    filters.push('type = @type_filter');
  } else if (opts.excludeTypes && opts.excludeTypes.length > 0) {
    opts.excludeTypes.forEach((t, i) => {
      params[`ex${i}`] = t;
      filters.push(`type <> @ex${i}`);
    });
  }
  const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
  const sql = `
    UPDATE jobs
       SET status = 'running',
           lease_owner = @owner,
           lease_until_ms = @lease_until,
           attempts = attempts + 1,
           updated_at_ms = @now
     WHERE id = (
       SELECT id FROM jobs
        WHERE status = 'queued' AND run_after_ms <= @now ${where}
        ORDER BY priority ASC, created_at_ms ASC
        LIMIT 1
     )
     RETURNING *
  `;
  // Filter shape varies, so cache per signature rather than one shared key.
  const cacheKey = `jobs.claim:${opts.type ?? ''}:${(opts.excludeTypes ?? []).length}`;
  return transactionImmediate(db, () => {
    return prepareCached(db, cacheKey, sql).get(params) as JobRow | undefined;
  });
}

/**
 * Return expired running leases to the queue so a crashed or slow worker's work
 * becomes reclaimable. Active (un-expired) leases and explicitly excluded
 * process-local jobs are untouched. Returns the number of jobs reclaimed.
 */
export function reclaimExpiredLeases(
  db: DatabaseSync,
  now: number,
  excludeJobIds: readonly string[] = [],
): number {
  const params: Record<string, SQLInputValue> = { now };
  const exclusions = excludeJobIds.map((id, index) => {
    const key = `exclude_${index}`;
    params[key] = id;
    return `id <> @${key}`;
  });
  const exclusionSql = exclusions.length > 0
    ? ` AND ${exclusions.join(' AND ')}`
    : '';
  const sql = `
    UPDATE jobs
       SET status = 'queued',
           lease_owner = NULL,
           lease_until_ms = NULL,
           updated_at_ms = @now
     WHERE status = 'running' AND lease_until_ms < @now${exclusionSql}
  `;
  return Number(
    prepareCached(db, `jobs.reclaim:${excludeJobIds.length}`, sql).run(params).changes,
  );
}

// ---- Completion, retry, cancellation ---------------------------------

export const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6 hours
export const RETRY_BASE_MS = 5_000; // 5 seconds

/**
 * Capped exponential backoff with jitter (Section 10):
 *   delay = min(6h, 5s × 2^attempts) + jitter
 * `attempts` is the count after the increment at claim time. jitter defaults to
 * a random value in [0, 1s); pass jitterMs explicitly for deterministic tests.
 */
export function computeRetryDelay(attempts: number, jitterMs?: number): number {
  const exp = RETRY_BASE_MS * 2 ** attempts;
  const capped = Math.min(RETRY_MAX_DELAY_MS, exp);
  const jitter = jitterMs ?? Math.floor(Math.random() * 1000);
  return capped + jitter;
}

const SUCCEED_SQL = `
  UPDATE jobs
     SET status = 'succeeded',
         completed_at_ms = @now,
         lease_owner = NULL,
         lease_until_ms = NULL,
         last_error = NULL,
         updated_at_ms = @now
   WHERE id = @id AND status = 'running'
`;

/** Mark a running job succeeded. Returns true when the transition applied. */
export function completeJob(db: DatabaseSync, id: string, now: number): boolean {
  return Number(prepareCached(db, 'jobs.succeed', SUCCEED_SQL).run({ id, now }).changes) > 0;
}

/** Return a claimed job to the queue at an explicit time without consuming an attempt. */
export function deferJob(db: DatabaseSync, id: string, runAfterMs: number, reason: string, now: number): boolean {
  return Number(prepareCached(db, 'jobs.defer', `UPDATE jobs
    SET status = 'queued', run_after_ms = @runAfterMs, attempts = max(0, attempts - 1),
        lease_owner = NULL, lease_until_ms = NULL, last_error = @reason, updated_at_ms = @now
    WHERE id = @id AND status = 'running'`).run({ id, runAfterMs, reason: reason.slice(0, 4000), now }).changes) > 0;
}

/** Requeue one progressing job and start a fresh per-phase retry boundary. */
export function continueJobAfterProgress(
  db: DatabaseSync,
  id: string,
  runAfterMs: number,
  now: number,
): boolean {
  return Number(prepareCached(db, 'jobs.continue_after_progress', `UPDATE jobs
    SET status = 'queued', run_after_ms = @runAfterMs, attempts = 0,
        lease_owner = NULL, lease_until_ms = NULL, last_error = NULL, updated_at_ms = @now
    WHERE id = @id AND status = 'running'`).run({ id, runAfterMs, now }).changes) > 0;
}

export interface FailOptions {
  id: string;
  error: unknown;
  now: number;
  /** Inject for deterministic tests; otherwise random jitter is used. */
  jitterMs?: number;
}

const FAIL_PERMANENT_SQL = `
  UPDATE jobs
     SET status = 'failed',
         completed_at_ms = @now,
         lease_owner = NULL,
         lease_until_ms = NULL,
         last_error = @last_error,
         updated_at_ms = @now
   WHERE id = @id AND status = 'running'
`;

const FAIL_RETRY_SQL = `
  UPDATE jobs
     SET status = 'queued',
         run_after_ms = @run_after,
         lease_owner = NULL,
         lease_until_ms = NULL,
         last_error = @last_error,
         updated_at_ms = @now
   WHERE id = @id AND status = 'running'
`;

export type FailOutcome = 'failed' | 'requeued';

/**
 * Apply the retry policy to a failed running job. Permanent errors, or jobs that
 * have exhausted `max_attempts`, transition to `failed`; otherwise the job is
 * requeued with a capped exponential delay. Returns the terminal outcome.
 */
export function failJob(db: DatabaseSync, opts: FailOptions): FailOutcome {
  const job = getJob(db, opts.id);
  if (!job) throw new Error(`failJob: job not found: ${opts.id}`);

  const classification = classifyError(opts.error);
  const exhausted = job.attempts >= job.max_attempts;
  const message = classification.message.slice(0, 4000);

  if (classification.permanent || exhausted) {
    prepareCached(db, 'jobs.fail_permanent', FAIL_PERMANENT_SQL).run({
      id: opts.id,
      last_error: message,
      now: opts.now,
    });
    return 'failed';
  }

  const runAfter = opts.now + computeRetryDelay(job.attempts, opts.jitterMs);
  prepareCached(db, 'jobs.fail_retry', FAIL_RETRY_SQL).run({
    id: opts.id,
    run_after: runAfter,
    last_error: message,
    now: opts.now,
  });
  return 'requeued';
}

const CANCEL_SQL = `
  UPDATE jobs
     SET status = 'cancelled',
         completed_at_ms = @now,
         lease_owner = NULL,
         lease_until_ms = NULL,
         updated_at_ms = @now
   WHERE id = @id AND status IN ('queued', 'running')
`;

/** Cancel a queued or running job. Returns true when the transition applied. */
export function cancelJob(db: DatabaseSync, id: string, now: number): boolean {
  return Number(prepareCached(db, 'jobs.cancel', CANCEL_SQL).run({ id, now }).changes) > 0;
}

/** Type guard for terminal statuses. */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Decode a job's payload JSON into its typed shape. */
export function readJobPayload<T extends JobType>(job: JobRow): JobTypePayloadMap[T] {
  return JSON.parse(job.payload_json) as JobTypePayloadMap[T];
}
