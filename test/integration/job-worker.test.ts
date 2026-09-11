import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { claimNextJob, enqueue } from '../../src/jobs/queue.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { categoryOf, defaultConcurrencyFor } from '../../src/jobs/handlers/index.js';
import { ContinueJobError, DeferJobError } from '../../src/jobs/errors.js';
import { ModelAdmissionController } from '../../src/agent/model-admission.js';

const NOW = 1_700_000_001_000;

function makeWorker(db: DatabaseSync, clock: () => number = () => NOW): JobWorker {
  return new JobWorker({
    db,
    owner: 'test-worker',
    leaseMs: 60_000,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 1000,
    clock,
  });
}

function statusOf(db: DatabaseSync, id: string): string {
  return (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string }).status;
}

describe('job category defaults', () => {
  it('maps types to categories with the right default caps', () => {
    expect(categoryOf('review_episode')).toBe('reviews');
    expect(categoryOf('review_due_memories')).toBe('reviews');
    expect(categoryOf('send_outbox')).toBe('sends');
    expect(categoryOf('sync_proposal_review')).toBe('sends');
    expect(categoryOf('backfill_channel')).toBe('backfills');
    expect(categoryOf('reconcile_channel')).toBe('backfills');
    expect(categoryOf('discover_threads')).toBe('backfills');
    expect(categoryOf('backup_database')).toBe('other');

    expect(defaultConcurrencyFor('review_episode')).toBe(1);
    expect(defaultConcurrencyFor('backfill_channel')).toBe(2);
    expect(defaultConcurrencyFor('send_outbox')).toBe(1);
  });
});

describe('job worker dispatch', () => {
  let env: TestDb;
  let db: DatabaseSync;
  beforeEach(() => {
    env = createTestDb();
    db = env.db;
  });
  afterEach(() => env.cleanup());

  it('runs a claimed job to completion via its handler', async () => {
    const seen: string[] = [];
    const worker = makeWorker(db);
    worker.register('backfill_channel', 1, async (payload) => {
      seen.push(payload.channelId);
    });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });

    await worker.runOnce();

    expect(seen).toEqual(['111']);
    const job = db.prepare('SELECT status, attempts FROM jobs WHERE type = ?').get('backfill_channel') as {
      status: string;
      attempts: number;
    };
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(1);
  });

  it('respects the per-type concurrency cap (claims no more than cap at once)', async () => {
    let resolveFirst!: () => void;
    const started: number[] = [];
    const blocking = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;

    const worker = makeWorker(db);
    worker.register('backfill_channel', 2, async (payload) => {
      calls++;
      started.push(Number(payload.channelId));
      if (calls <= 2) await blocking; // first two stay in-flight
    });

    for (const id of ['1', '2', '3', '4']) {
      enqueue(db, { type: 'backfill_channel', payload: { channelId: id }, now: NOW });
    }

    const startedCount = worker.dispatch(); // claims up to cap=2
    expect(startedCount).toBe(2);
    expect(worker.inflightFor('backfill_channel')).toBe(2);
    // The remaining two are still queued.
    expect(
      (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='queued'").get() as { n: number }).n,
    ).toBe(2);

    resolveFirst(); // release both blocking handlers
    await worker.settle();
    expect(started).toEqual([1, 2]);

    // Next dispatch picks up the rest.
    const more = worker.dispatch();
    expect(more).toBe(2);
    await worker.settle();
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it('fails an unknown job type terminally instead of retrying', async () => {
    const worker = makeWorker(db);
    worker.register('backfill_channel', 1, async () => {});
    enqueue(db, { type: 'maintenance', payload: {}, now: NOW });

    await worker.runOnce();

    const job = db.prepare('SELECT status, last_error FROM jobs WHERE type = ?').get('maintenance') as {
      status: string;
      last_error: string;
    };
    expect(job.status).toBe('failed');
    expect(job.last_error).toContain('no handler registered');
  });

  it('continues processing after a handler throws (transient retry)', async () => {
    let calls = 0;
    const worker = makeWorker(db, () => NOW);
    worker.register('backfill_channel', 1, async () => {
      calls++;
      if (calls === 1) throw new Error('transient boom');
    });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });

    await worker.runOnce();
    // First attempt failed transiently → requeued with a future run_after.
    const after = db.prepare('SELECT status, run_after_ms FROM jobs WHERE type = ?').get(
      'backfill_channel',
    ) as { status: string; run_after_ms: number };
    expect(after.status).toBe('queued');
    expect(after.run_after_ms).toBeGreaterThan(NOW);
    expect(calls).toBe(1);

    // A second run (after the delay) succeeds.
    const worker2 = makeWorker(db, () => after.run_after_ms + 1);
    worker2.register('backfill_channel', 1, async () => {});
    await worker2.runOnce();
    expect(statusOf(db, (db.prepare('SELECT id FROM jobs WHERE type = ?').get('backfill_channel') as { id: string }).id)).toBe(
      'succeeded',
    );
  });

  it('defers externally gated work without consuming an attempt', async () => {
    const worker = makeWorker(db, () => NOW);
    worker.register('review_episode', 1, async () => {
      throw new DeferJobError('daily model budget exhausted', 90_000);
    });
    const queued = enqueue(db, { type: 'review_episode', payload: { episodeId: 'ep-1' }, now: NOW });

    await worker.runOnce();

    const job = db.prepare('SELECT status, attempts, run_after_ms, last_error FROM jobs WHERE id = ?').get(queued.id) as {
      status: string; attempts: number; run_after_ms: number; last_error: string;
    };
    expect(job).toMatchObject({ status: 'queued', attempts: 0, run_after_ms: NOW + 90_000 });
    expect(job.last_error).toContain('budget');
  });

  it('starts a fresh retry boundary after durable progress on the same job row', async () => {
    let now = NOW;
    let calls = 0;
    const worker = makeWorker(db, () => now);
    worker.register('deep_recap', 1, async () => {
      calls += 1;
      if (calls === 2) throw new ContinueJobError('partition completed', 1);
      throw new Error(`transient phase failure ${calls}`);
    });
    const queued = enqueue(db, {
      type: 'deep_recap',
      payload: { recapId: 'recap-progress-retries' },
      uniqueKey: 'deep-recap:recap-progress-retries',
      maxAttempts: 2,
      now,
    });

    await worker.runOnce();
    let job = db.prepare(`SELECT status,attempts,run_after_ms,unique_key
      FROM jobs WHERE id=?`).get(queued.id) as {
        status: string; attempts: number; run_after_ms: number; unique_key: string;
      };
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });

    now = job.run_after_ms + 1;
    await worker.runOnce();
    job = db.prepare(`SELECT status,attempts,run_after_ms,unique_key
      FROM jobs WHERE id=?`).get(queued.id) as typeof job;
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 0,
      unique_key: 'deep-recap:recap-progress-retries',
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type='deep_recap'").get())
      .toEqual({ n: 1 });

    now = job.run_after_ms + 1;
    await worker.runOnce();
    job = db.prepare('SELECT status,attempts,run_after_ms,unique_key FROM jobs WHERE id=?')
      .get(queued.id) as typeof job;
    // Without the progress reset this second distributed transient would have
    // exhausted maxAttempts=2 and terminalized the long recap.
    expect(job).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('start/stop processes queued work and then idles', async () => {
    const worker = makeWorker(db);
    worker.register('backfill_channel', 2, async () => {});
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });

    worker.start();
    // Wait until the job reaches a terminal status (not merely claimed/running).
    await vi.waitFor(() => {
      expect(
        (db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get() as { n: number })
          .n,
      ).toBe(1);
    });
    expect(worker.isIdle()).toBe(true);
    const clean = await worker.waitForShutdown();
    expect(clean).toBe(true);
    expect(worker.isIdle()).toBe(true);
  });

  it('claims a new direct answer while a campaign handler and background waiter are blocked', async () => {
    const clock = () => NOW + 2;
    const worker = makeWorker(db, clock);
    const admission = new ModelAdmissionController({ capacity: 1, directBurstLimit: 3 });
    const admitted: string[] = [];
    let unblockCampaign!: () => void;
    const campaignBlock = new Promise<void>((resolve) => {
      unblockCampaign = resolve;
    });

    worker.register('review_episode', 2, async (payload) => {
      const release = await admission.acquire('background');
      admitted.push(payload.episodeId);
      if (payload.episodeId === 'campaign-active') await campaignBlock;
      release();
    });
    worker.register('direct_answer', 1, async () => {
      const release = await admission.acquire('direct_answer');
      admitted.push('direct-answer');
      release();
    });

    enqueue(db, {
      type: 'review_episode',
      payload: { episodeId: 'campaign-active' },
      now: NOW,
    });
    enqueue(db, {
      type: 'review_episode',
      payload: { episodeId: 'campaign-waiter' },
      now: NOW + 1,
    });
    worker.start();

    await vi.waitFor(() => {
      expect(admitted).toEqual(['campaign-active']);
      expect(admission.queuedBackgroundCount).toBe(1);
      expect(worker.inflightFor('review_episode')).toBe(2);
    });

    const direct = enqueue(db, {
      type: 'direct_answer',
      payload: { messageId: 'mention-1', channelId: 'channel-1' },
      priority: 25,
      now: NOW + 2,
    });

    // The polling loop continues dispatching even though both campaign handlers
    // are active. The direct handler is claimed and waits at model admission.
    await vi.waitFor(
      () => {
        expect(statusOf(db, direct.id)).toBe('running');
        expect(worker.inflightFor('direct_answer')).toBe(1);
        expect(admission.queuedDirectCount).toBe(1);
      },
      // The test worker polls every 5ms. Keep a finite upper bound so reverting
      // to "await every active handler" deterministically times out here while
      // the campaign remains blocked (production uses the same loop at 1s).
      { timeout: 250, interval: 5 },
    );
    expect(admitted).toEqual(['campaign-active']); // no preemption

    unblockCampaign();
    await vi.waitFor(() => {
      expect(admitted).toEqual([
        'campaign-active',
        'direct-answer',
        'campaign-waiter',
      ]);
      expect(statusOf(db, direct.id)).toBe('succeeded');
      expect(worker.isIdle()).toBe(true);
    });

    expect(await worker.waitForShutdown()).toBe(true);
    expect(admission.activeCount).toBe(0);
  });

  it('does not reclaim a locally active job after lease expiry but recovers another expired job', async () => {
    let now = NOW;
    const leaseMs = 100;
    const worker = new JobWorker({
      db,
      owner: 'continuous-worker',
      leaseMs,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 1_000,
      clock: () => now,
    });
    const runs = new Map<string, number>();
    let releaseActive!: () => void;
    const activeBlock = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    worker.register('backfill_channel', 2, async ({ channelId }) => {
      runs.set(channelId, (runs.get(channelId) ?? 0) + 1);
      if (channelId === 'active') await activeBlock;
    });

    // Simulate work orphaned by a dead process, then start one genuinely active
    // handler in this worker. Both leases expire when the injected clock moves.
    const orphan = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: 'orphan' },
      now,
    });
    claimNextJob(db, { owner: 'dead-worker', now, leaseMs, type: 'backfill_channel' });
    const active = enqueue(db, {
      type: 'backfill_channel',
      payload: { channelId: 'active' },
      now: now + 1,
    });
    now += 1;

    worker.start();
    await vi.waitFor(() => {
      expect(runs.get('active')).toBe(1);
      expect(statusOf(db, active.id)).toBe('running');
    });

    now += leaseMs + 1;
    await vi.waitFor(() => {
      expect(runs.get('orphan')).toBe(1);
      expect(statusOf(db, orphan.id)).toBe('succeeded');
    });

    // Several continuous dispatch rounds have now observed the active row with
    // an expired lease. It must stay owned by the original handler, not restart.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(runs.get('active')).toBe(1);
    expect(statusOf(db, active.id)).toBe('running');
    expect(
      (db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(active.id) as { attempts: number })
        .attempts,
    ).toBe(1);

    releaseActive();
    await vi.waitFor(() => {
      expect(statusOf(db, active.id)).toBe('succeeded');
      expect(worker.isIdle()).toBe(true);
    });
    expect(runs.get('active')).toBe(1);
    expect(await worker.waitForShutdown()).toBe(true);
  });

  it('waitForShutdown returns true promptly when idle', async () => {
    const worker = makeWorker(db);
    worker.register('backfill_channel', 1, async () => {});
    const clean = await worker.waitForShutdown();
    expect(clean).toBe(true);
  });

  it('returns false when a handler exceeds the shutdown timeout', async () => {
    const worker = new JobWorker({
      db,
      owner: 'slow',
      leaseMs: 60_000,
      pollIntervalMs: 5,
      shutdownTimeoutMs: 30,
      clock: () => NOW,
    });
    let release!: () => void;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.register('backfill_channel', 1, async () => {
      await hang;
    });
    enqueue(db, { type: 'backfill_channel', payload: { channelId: '111' }, now: NOW });
    worker.dispatch();

    const clean = await worker.waitForShutdown();
    expect(clean).toBe(false); // timed out
    release(); // unblock the hanging handler before teardown
    await worker.settle();
  });
});
