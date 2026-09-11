import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createTestDb, type TestDb } from '../helpers/db.js';
import type { DatabaseSync } from 'node:sqlite';
import { RuntimeState } from '../../src/runtime-state.js';
import { JobWorker } from '../../src/jobs/worker.js';
import { transaction } from '../../src/db/database.js';
import { enqueue, claimNextJob, reclaimExpiredLeases } from '../../src/jobs/queue.js';
import {
  ShutdownCoordinator,
  createShutdownDeps,
  installShutdownSignalHandlers,
  type ShutdownDeps,
  type SignalHandlerTarget,
} from '../../src/shutdown.js';
import type { Logger } from 'pino';
import type { JobType } from '../../src/jobs/types.js';

/**
 * Graceful shutdown (Section 34).
 *
 * Acceptance: "Signal tests show no new work starts, short transactions finish,
 * resources close, and a restart recovers incomplete durable work."
 */

const NOW = 1_700_000_000_000;
const LEASE_MS = 60_000;

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  fatal() {},
  trace() {},
  child() {
    return this;
  },
} as unknown as Logger;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A minimal job type whose payload is empty, for driving the worker in tests. */
const JOB_TYPE: JobType = 'maintenance';

let env: TestDb;
let db: DatabaseSync;
let runtime: RuntimeState;

beforeEach(() => {
  env = createTestDb();
  db = env.db;
  runtime = new RuntimeState();
});
afterEach(() => env.cleanup());

function jobStatus(id: string): string {
  return (db.prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: string }).status;
}

function makeWorker(opts: { owner?: string; shutdownTimeoutMs?: number } = {}): JobWorker {
  return new JobWorker({
    db,
    owner: opts.owner ?? 'worker-1',
    leaseMs: LEASE_MS,
    pollIntervalMs: 5,
    shutdownTimeoutMs: opts.shutdownTimeoutMs ?? 10_000,
    clock: () => NOW,
  });
}

/** Deps that drain a worker but leave the database open for post-shutdown inspection. */
function drainOnlyDeps(worker: JobWorker): ShutdownDeps {
  return {
    markReadinessDown: () => runtime.beginShutdown(),
    drainWorkers: async () => worker.waitForShutdown(),
    persistEpisodes: () => {},
    disconnectDiscord: () => {},
    checkpoint: () => {},
    closeDatabase: () => {},
  };
}

describe('ShutdownCoordinator — full ordered sequence', () => {
  it('marks readiness down, runs every teardown stage, and closes the database', async () => {
    let discordDestroyed = false;
    let episodesPersisted = false;
    const deps: ShutdownDeps = {
      markReadinessDown: () => runtime.beginShutdown(),
      drainWorkers: async () => true,
      persistEpisodes: () => {
        episodesPersisted = true;
      },
      disconnectDiscord: () => {
        discordDestroyed = true;
      },
      checkpoint: () => {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      },
      closeDatabase: () => {
        db.close();
      },
    };
    const coord = new ShutdownCoordinator(deps, { drainDeadlineMs: 1000, log: silentLogger });
    const result = await coord.begin();

    expect(runtime.isShuttingDown()).toBe(true);
    expect(runtime.isReady()).toBe(false);
    expect(episodesPersisted).toBe(true);
    expect(discordDestroyed).toBe(true);
    expect(result.drained).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stages).toEqual({
      readiness: 'ok',
      drain: 'ok',
      episodes: 'ok',
      discord: 'ok',
      checkpoint: 'ok',
      database: 'ok',
    });
    // Database is actually closed.
    expect(() => db.prepare('SELECT 1').get()).toThrow();
  });

  it('is idempotent: a second begin() returns the same in-flight promise', async () => {
    const deps: ShutdownDeps = {
      markReadinessDown: () => {},
      drainWorkers: async () => true,
      persistEpisodes: () => {},
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { log: silentLogger });
    const a = coord.begin();
    const b = coord.begin();
    expect(a).toBe(b);
    await a;
  });

  it('isolates stage failures: a thrown stage is recorded, later stages still run', async () => {
    const deps: ShutdownDeps = {
      markReadinessDown: () => {},
      drainWorkers: async () => true,
      persistEpisodes: () => {
        throw new Error('episode flush failed');
      },
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { log: silentLogger });
    const result = await coord.begin();
    expect(result.stages.episodes).toBe('failed');
    expect(result.stages.discord).toBe('ok');
    expect(result.stages.checkpoint).toBe('ok');
    expect(result.stages.database).toBe('ok');
  });

  it('times out a stage that does not settle within the stage budget', async () => {
    const deps: ShutdownDeps = {
      markReadinessDown: () => {},
      drainWorkers: async () => true,
      persistEpisodes: () => sleep(10_000),
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { drainDeadlineMs: 1000, stageTimeoutMs: 30, log: silentLogger });
    const result = await coord.begin();
    expect(result.stages.episodes).toBe('timeout');
  });
});

describe('ShutdownCoordinator — worker drain', () => {
  it('does not start new work after shutdown: a now-due job stays queued', async () => {
    const worker = makeWorker();
    worker.register(JOB_TYPE, 1, async () => {});
    // Seed a job that is not yet due, start the loop, then shut down.
    const { id } = enqueue(db, { type: JOB_TYPE, payload: {}, runAfterMs: NOW + 100_000, now: NOW });
    worker.start();
    await sleep(10); // let the loop poll once and go idle

    const coord = new ShutdownCoordinator(drainOnlyDeps(worker), { drainDeadlineMs: 1000, log: silentLogger });
    await coord.begin();

    // Now make the job due. The stopped loop must not claim it.
    db.prepare('UPDATE jobs SET run_after_ms = 0 WHERE id = ?').run(id);
    await sleep(30);
    expect(jobStatus(id)).toBe('queued');
  });

  it('lets a short in-flight transaction finish and completes the job', async () => {
    const worker = makeWorker();
    let txnRan = false;
    worker.register(JOB_TYPE, 1, async () => {
      await sleep(20);
      transaction(db, () => {
        db.prepare("INSERT INTO settings (key, value_json, updated_at_ms) VALUES ('k','1',?)").run(NOW);
        txnRan = true;
      });
    });
    const { id } = enqueue(db, { type: JOB_TYPE, payload: {}, now: NOW });
    worker.dispatch(); // claim + start the handler (in-flight)

    const coord = new ShutdownCoordinator(drainOnlyDeps(worker), { drainDeadlineMs: 2000, log: silentLogger });
    const result = await coord.begin();

    expect(result.drained).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(txnRan).toBe(true);
    expect(jobStatus(id)).toBe('succeeded');
  });

  it('leaves an unfinished job recoverable when the drain deadline elapses', async () => {
    const { promise, resolve } = deferred();
    const worker = makeWorker();
    worker.register(JOB_TYPE, 1, async () => {
      await promise; // never resolves during the assertions
    });
    const { id } = enqueue(db, { type: JOB_TYPE, payload: {}, now: NOW });
    worker.dispatch(); // claim + start the long handler (in-flight, job 'running')

    // closeDatabase is a no-op so the database stays open for recovery inspection.
    const deps: ShutdownDeps = {
      markReadinessDown: () => runtime.beginShutdown(),
      drainWorkers: async () => {
        const ok = await worker.waitForShutdown();
        return ok;
      },
      persistEpisodes: () => {},
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { drainDeadlineMs: 40, log: silentLogger });
    const result = await coord.begin();

    expect(result.timedOut).toBe(true);
    expect(result.drained).toBe(false);
    expect(jobStatus(id)).toBe('running'); // lease still held, not force-cancelled

    // --- simulate a restart after the lease expires ---
    const restartAt = NOW + LEASE_MS + 1;
    expect(reclaimExpiredLeases(db, restartAt)).toBe(1);
    expect(jobStatus(id)).toBe('queued');
    const reclaimed = claimNextJob(db, { owner: 'restart', now: restartAt, leaseMs: LEASE_MS, type: JOB_TYPE });
    expect(reclaimed?.id).toBe(id);
    expect(jobStatus(id)).toBe('running'); // re-leased to the restarted worker

    // Release the orphaned handler so the test exits cleanly.
    resolve();
    await sleep(5);
  });
});

describe('createShutdownDeps', () => {
  it('checkpoints and closes the real database with no workers/discord', async () => {
    const deps = createShutdownDeps({ db, runtime });
    const coord = new ShutdownCoordinator(deps, { drainDeadlineMs: 500, log: silentLogger });
    const result = await coord.begin();
    expect(result.drained).toBe(true);
    expect(result.stages.checkpoint).toBe('ok');
    expect(result.stages.database).toBe('ok');
    expect(() => db.prepare('SELECT 1').get()).toThrow();
  });
});

describe('installShutdownSignalHandlers', () => {
  class FakeTarget extends EventEmitter {
    readonly exits: number[] = [];
    exit(code?: number): void {
      this.exits.push(code ?? 0);
    }
  }

  it('runs the coordinator and exits zero on SIGTERM', async () => {
    const target = new FakeTarget();
    const deps: ShutdownDeps = {
      markReadinessDown: () => {},
      drainWorkers: async () => true,
      persistEpisodes: () => {},
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { log: silentLogger });
    const remove = installShutdownSignalHandlers(coord, { log: silentLogger, target: target as unknown as SignalHandlerTarget });

    target.emit('SIGTERM', 'SIGTERM');
    // The exit happens after the async begin() resolves.
    await sleep(20);

    expect(coord.isShuttingDown()).toBe(true);
    expect(target.exits).toEqual([0]);
    remove();
  });

  it('ignores a repeated signal (idempotent coordinator)', async () => {
    const target = new FakeTarget();
    const deps: ShutdownDeps = {
      markReadinessDown: () => {},
      drainWorkers: async () => true,
      persistEpisodes: () => {},
      disconnectDiscord: () => {},
      checkpoint: () => {},
      closeDatabase: () => {},
    };
    const coord = new ShutdownCoordinator(deps, { log: silentLogger });
    installShutdownSignalHandlers(coord, { log: silentLogger, target: target as unknown as SignalHandlerTarget });

    target.emit('SIGINT', 'SIGINT');
    target.emit('SIGINT', 'SIGINT');
    await sleep(20);

    // Two signals, but only one exit (the second reuses the in-flight promise).
    expect(target.exits).toEqual([0]);
  });
});
