import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  enqueue,
  claimNextJob,
  reclaimExpiredLeases,
  getJob,
} from '../../src/jobs/queue.js';

const NOW = 1_700_000_001_000;
const LEASE_MS = 60_000;

describe('job leasing and expired-lease recovery', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
  });

  it('claims the single due job and sets the lease', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const job = claimNextJob(db, { owner: 'worker-A', now: NOW, leaseMs: LEASE_MS })!;
    expect(job).toBeDefined();
    expect(job.status).toBe('running');
    expect(job.lease_owner).toBe('worker-A');
    expect(job.lease_until_ms).toBe(NOW + LEASE_MS);
    expect(job.attempts).toBe(1);
  });

  it('a second claimant gets nothing while the lease is live (one claimant)', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    const first = claimNextJob(db, { owner: 'A', now: NOW, leaseMs: LEASE_MS });
    const second = claimNextJob(db, { owner: 'B', now: NOW + 1, leaseMs: LEASE_MS });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('returns nothing when no job is due', () => {
    enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: '111' },
      runAfterMs: NOW + 10_000,
      now: NOW,
    });
    expect(claimNextJob(db, { owner: 'A', now: NOW, leaseMs: LEASE_MS })).toBeUndefined();
  });

  it('claims in priority then creation order', () => {
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, priority: 100, now: NOW });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '222' }, priority: 0, now: NOW + 1 });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '333' }, priority: 0, now: NOW + 2 });

    const first = claimNextJob(db, { owner: 'A', now: NOW + 3, leaseMs: LEASE_MS })!;
    expect(JSON.parse(first.payload_json).channelId).toBe('222'); // priority 0, earlier
    const second = claimNextJob(db, { owner: 'A', now: NOW + 3, leaseMs: LEASE_MS })!;
    expect(JSON.parse(second.payload_json).channelId).toBe('333');
    const third = claimNextJob(db, { owner: 'A', now: NOW + 3, leaseMs: LEASE_MS })!;
    expect(JSON.parse(third.payload_json).channelId).toBe('111');
  });

  it('makes an expired lease reclaimable by another worker', () => {
    enqueue(db, { type: 'reconcile_channel', payload: { channelId: '111' }, now: NOW });
    claimNextJob(db, { owner: 'A', now: NOW, leaseMs: LEASE_MS });

    // Still running, before expiry: not reclaimable, no new claim.
    expect(claimNextJob(db, { owner: 'B', now: NOW + LEASE_MS - 1, leaseMs: LEASE_MS })).toBeUndefined();

    // After expiry: reclaim returns it to the queue, then B can claim it.
    const reclaimed = reclaimExpiredLeases(db, NOW + LEASE_MS + 1);
    expect(reclaimed).toBe(1);

    const second = claimNextJob(db, { owner: 'B', now: NOW + LEASE_MS + 1, leaseMs: LEASE_MS })!;
    expect(second.lease_owner).toBe('B');
    expect(second.attempts).toBe(2); // claimed a second time
  });

  it('reclaim touches only expired leases and leaves active ones alone', () => {
    enqueue(db, { type: 'reconcile_channel', payload: { channelId: '111' }, now: NOW });
    enqueue(db, { type: 'reconcile_channel', payload: { channelId: '222' }, now: NOW });
    const live = claimNextJob(db, { owner: 'A', now: NOW, leaseMs: LEASE_MS })!;
    const expiring = claimNextJob(db, { owner: 'A', now: NOW, leaseMs: LEASE_MS })!;

    // Pretend 'expiring' was leased long ago by backdating its lease.
    db.prepare('UPDATE jobs SET lease_until_ms = ? WHERE id = ?').run(NOW - 1, expiring.id);

    const reclaimed = reclaimExpiredLeases(db, NOW + 1);
    expect(reclaimed).toBe(1);
    expect(getJob(db, live.id)!.status).toBe('running'); // untouched
    expect(getJob(db, expiring.id)!.status).toBe('queued'); // recovered
  });
});
