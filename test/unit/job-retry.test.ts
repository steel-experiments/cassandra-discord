import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  enqueue,
  claimNextJob,
  completeJob,
  failJob,
  cancelJob,
  computeRetryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_DELAY_MS,
} from '../../src/jobs/queue.js';
import { PermanentJobError } from '../../src/jobs/errors.js';

const NOW = 1_700_000_001_000;
const LEASE_MS = 60_000;
const JITTER = 0; // deterministic

describe('retry policy — computeRetryDelay bounds', () => {
  it('grows as 5s × 2^attempts and caps at 6 hours', () => {
    expect(computeRetryDelay(0, JITTER)).toBe(RETRY_BASE_MS * 1);
    expect(computeRetryDelay(1, JITTER)).toBe(RETRY_BASE_MS * 2);
    expect(computeRetryDelay(2, JITTER)).toBe(RETRY_BASE_MS * 4);
    expect(computeRetryDelay(3, JITTER)).toBe(RETRY_BASE_MS * 8);

    // Very large attempt count is capped.
    expect(computeRetryDelay(50, JITTER)).toBe(RETRY_MAX_DELAY_MS);
  });

  it('adds non-negative jitter', () => {
    const d = computeRetryDelay(2, 123);
    expect(d).toBe(RETRY_BASE_MS * 4 + 123);
  });
});

describe('job completion, retry, and permanent failure', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
  });

  function claimOne(): NonNullable<ReturnType<typeof claimNextJob>> {
    const job = claimNextJob(db, { owner: 'w', now: NOW, leaseMs: LEASE_MS });
    if (!job) throw new Error('no job to claim');
    return job;
  }

  it('marks a completed job succeeded and clears the lease', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const job = claimOne();
    expect(completeJob(db, job.id, NOW + 5)).toBe(true);
    const after = getJobRow(db, job.id);
    expect(after.status).toBe('succeeded');
    expect(after.lease_owner).toBeNull();
    expect(after.completed_at_ms).toBe(NOW + 5);
    expect(after.last_error).toBeNull();
  });

  it('requeues a transient failure with capped backoff and clears the lease', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const job = claimOne();
    const outcome = failJob(db, {
      id: job.id,
      error: new Error('rate limited'),
      now: NOW,
      jitterMs: JITTER,
    });
    expect(outcome).toBe('requeued');
    const after = getJobRow(db, job.id);
    expect(after.status).toBe('queued');
    expect(after.lease_owner).toBeNull();
    expect(after.run_after_ms).toBe(NOW + RETRY_BASE_MS * 2); // attempt 1 → 2^1
    expect(after.last_error).toContain('rate limited');
    expect(after.attempts).toBe(1);
  });

  it('classifies a Discord 403 as permanent and fails terminally', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const job = claimOne();
    const err: Error & { status: number } = Object.assign(new Error('Missing Access'), {
      status: 403,
    });
    const outcome = failJob(db, { id: job.id, error: err, now: NOW });
    expect(outcome).toBe('failed');
    const after = getJobRow(db, job.id);
    expect(after.status).toBe('failed');
    expect(after.completed_at_ms).toBe(NOW);
    expect(after.last_error).toContain('Missing Access');
  });

  it('treats a PermanentJobError as terminal regardless of attempts', () => {
    enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: '111' },
      maxAttempts: 10,
      now: NOW,
    });
    const job = claimOne();
    const outcome = failJob(db, {
      id: job.id,
      error: new PermanentJobError('unknown channel'),
      now: NOW,
    });
    expect(outcome).toBe('failed');
    expect(getJobRow(db, job.id).status).toBe('failed');
  });

  it('stops retrying after max_attempts and fails terminally', () => {
    enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: '111' },
      maxAttempts: 2,
      now: NOW,
    });

    // Attempt 1: transient → requeued.
    let job = claimOne();
    failJob(db, { id: job.id, error: new Error('boom'), now: NOW, jitterMs: JITTER });
    expect(getJobRow(db, job.id).status).toBe('queued');

    // Attempt 2 (== max): exhausted → failed.
    job = claimNextJob(db, { owner: 'w', now: getJobRow(db, job.id).run_after_ms, leaseMs: LEASE_MS })!;
    expect(job.attempts).toBe(2);
    const outcome = failJob(db, { id: job.id, error: new Error('boom'), now: NOW, jitterMs: JITTER });
    expect(outcome).toBe('failed');
    expect(getJobRow(db, job.id).status).toBe('failed');
  });

  it('cancel transitions queued or running jobs to cancelled', () => {
    enqueue(db, { type: 'maintenance', payload: {}, now: NOW });
    const job = claimOne();
    expect(cancelJob(db, job.id, NOW)).toBe(true);
    expect(getJobRow(db, job.id).status).toBe('cancelled');
    expect(getJobRow(db, job.id).lease_owner).toBeNull();

    // Cancelling an already-terminal job is a no-op.
    expect(cancelJob(db, job.id, NOW)).toBe(false);
  });
});

function getJobRow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>;
  return row as unknown as {
    status: string;
    lease_owner: string | null;
    run_after_ms: number;
    attempts: number;
    completed_at_ms: number | null;
    last_error: string | null;
  };
}
