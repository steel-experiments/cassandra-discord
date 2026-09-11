import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  enqueue,
  getJob,
  findActiveUniqueJob,
  countJobsByStatus,
  claimNextJob,
  completeJob,
} from '../../src/jobs/queue.js';
import { validateJobPayload } from '../../src/jobs/types.js';

const NOW = 1_700_000_001_000;

describe('job enqueue and uniqueness', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
  });

  it('enqueues a job with defaults and stores the typed payload', () => {
    const res = enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    expect(res.enqueued).toBe(true);
    const job = getJob(db, res.id)!;
    expect(job.type).toBe('backfill_channel');
    expect(job.status).toBe('queued');
    expect(job.priority).toBe(100);
    expect(job.max_attempts).toBe(10);
    expect(job.run_after_ms).toBe(NOW);
    expect(JSON.parse(job.payload_json)).toEqual({ channelId: '111' });
    expect(job.unique_key).toBeNull();
  });

  it('collapses duplicate active unique jobs into one row', () => {
    const a = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: '111' },
      uniqueKey: 'channel:111',
      now: NOW,
    });
    expect(a.enqueued).toBe(true);

    const b = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: '111' },
      uniqueKey: 'channel:111',
      now: NOW,
    });
    expect(b.enqueued).toBe(false); // collapsed
    expect(b.id).not.toBe(a.id);

    // Exactly one active job for this key.
    const active = findActiveUniqueJob(db, 'backfill_channel', 'channel:111');
    expect(active?.id).toBe(a.id);
    expect(countJobsByStatus(db, 'queued')).toBe(1);
  });

  it('lets unrelated unique jobs and same-type different-key jobs coexist', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, uniqueKey: 'channel:111', now: NOW });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '222' }, uniqueKey: 'channel:222', now: NOW });
    enqueue(db, { type: 'reconcile_channel', payload: { channelId: '111' }, uniqueKey: 'channel:111', now: NOW });
    expect(countJobsByStatus(db, 'queued')).toBe(3);
  });

  it('re-enqueues after the active unique job completes', () => {
    enqueue(db, {
      type: 'backup_database',
      payload: {},
      uniqueKey: 'daily-backup',
      now: NOW,
    });
    const claimed = claimNextJob(db, { owner: 'w', now: NOW, leaseMs: 1000 })!;
    completeJob(db, claimed.id, NOW);

    const second = enqueue(db, {
      type: 'backup_database',
      payload: {},
      uniqueKey: 'daily-backup',
      now: NOW + 1,
    });
    expect(second.enqueued).toBe(true); // completed job freed the unique slot
  });

  it('accepts jobs with no unique key as always-distinct', () => {
    enqueue(db, { type: 'maintenance', payload: {}, now: NOW });
    enqueue(db, { type: 'maintenance', payload: {}, now: NOW });
    expect(countJobsByStatus(db, 'queued')).toBe(2);
  });

  it('validates required payload fields', () => {
    expect(() =>
      enqueue(db, { type: 'backfill_channel', payload: {} as { channelId: string }, now: NOW }),
    ).toThrow(/channelId/);
    expect(() => validateJobPayload('review_episode', { episodeId: '' })).toThrow(/episodeId/);
    // Types with no required fields accept anything.
    expect(() => validateJobPayload('maintenance', {})).not.toThrow();
  });

  it('strictly validates scheduled cohort snapshots', () => {
    const valid = {
      routeKind: 'working' as const,
      targetChannelId: 'channel-1',
      subjects: [{ memoryId: 'memory-1', memoryFingerprint: 'fingerprint-1' }],
    };
    expect(() => validateJobPayload('review_due_memory_cohort', valid)).not.toThrow();
    expect(() => validateJobPayload('review_due_memory_cohort', {
      ...valid, routeKind: 'fallback' as never,
    })).toThrow(/route kind/);
    expect(() => validateJobPayload('review_due_memory_cohort', {
      ...valid, subjects: [],
    })).toThrow(/1 to 20/);
    expect(() => validateJobPayload('review_due_memory_cohort', {
      ...valid, subjects: [valid.subjects[0]!, valid.subjects[0]!],
    })).toThrow(/duplicate/);
    expect(() => validateJobPayload('review_due_memory_cohort', {
      ...valid, subjects: [{ memoryId: 'memory-1', memoryFingerprint: '' }],
    })).toThrow(/malformed/);
  });

  it('honors explicit priority, run_after, and max_attempts', () => {
    const res = enqueue(db, {
      type: 'close_episode',
      payload: { episodeId: '222' },
      priority: 0,
      runAfterMs: NOW + 5000,
      maxAttempts: 3,
      now: NOW,
    });
    const job = getJob(db, res.id)!;
    expect(job.priority).toBe(0);
    expect(job.run_after_ms).toBe(NOW + 5000);
    expect(job.max_attempts).toBe(3);
  });
});
