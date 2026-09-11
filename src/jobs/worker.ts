import { type DatabaseSync } from '../db/database.js';
import {
  claimNextJob,
  completeJob,
  continueJobAfterProgress,
  deferJob,
  failJob,
  reclaimExpiredLeases,
  readJobPayload,
} from './queue.js';
import { ContinueJobError, DeferJobError, PermanentJobError } from './errors.js';
import { categoryOf } from './handlers/index.js';
import type { JobRow, JobType, JobTypePayloadMap } from './types.js';

/**
 * Bounded job worker dispatch (Section 5.1, 10, 11.5, 34).
 *
 * Handlers run OUTSIDE any database transaction: the claim transaction commits
 * first, then the handler executes (it may do model/Discord/network work), then
 * a second short transaction records the outcome. Per-type concurrency caps keep
 * reviews, sends, and backfills bounded independently. Unknown job types fail
 * terminally rather than retrying forever.
 */

export interface JobHandler<T extends JobType> {
  (payload: JobTypePayloadMap[T], job: JobRow): Promise<void>;
}

interface RegisteredHandler {
  type: JobType;
  concurrency: number;
  // Stored with an erased payload; the public register() preserves typing.
  run: (job: JobRow) => Promise<void>;
}

export interface WorkerOptions {
  db: DatabaseSync;
  /** Stable lease owner id (e.g. hostname or process id). */
  owner: string;
  /** Lease duration granted to each claimed job. */
  leaseMs: number;
  /** Idle poll interval between dispatch rounds. */
  pollIntervalMs: number;
  /** How long to wait for in-flight handlers during shutdown. */
  shutdownTimeoutMs: number;
  /**
   * Durable pause predicate (Section 27). When it returns true,
   * dispatch skips claiming new `reviews` and `sends` jobs — agent reviews and
   * outbound sends — while ingestion (`backfills`) and other housekeeping
   * continue. In-flight handlers are never cancelled. Defaults to "never paused".
   */
  isPaused?: () => boolean;
  /** Inject a clock for deterministic tests (default Date.now). */
  clock?: () => number;
}

export class JobWorker {
  private readonly db: DatabaseSync;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly isPaused: () => boolean;
  private readonly clock: () => number;
  private readonly handlers = new Map<JobType, RegisteredHandler>();
  private readonly inFlight = new Map<JobType, number>();
  private readonly active = new Set<Promise<void>>();
  /** Jobs whose handlers are still executing in this process. */
  private readonly activeJobIds = new Set<string>();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollWake: (() => void) | null = null;

  constructor(opts: WorkerOptions) {
    this.db = opts.db;
    this.owner = opts.owner;
    this.leaseMs = opts.leaseMs;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs;
    this.isPaused = opts.isPaused ?? (() => false);
    this.clock = opts.clock ?? Date.now;
  }

  /** Register a handler and its per-type concurrency cap. */
  register<T extends JobType>(type: T, concurrency: number, handler: JobHandler<T>): void {
    if (concurrency < 1) throw new Error(`concurrency must be >= 1 for ${type}`);
    this.handlers.set(type, {
      type,
      concurrency,
      run: async (job) => {
        await handler(readJobPayload<T>(job), job);
      },
    });
  }

  /** The set of types that have a registered handler. */
  registeredTypes(): JobType[] {
    return [...this.handlers.keys()];
  }

  /** True when no handlers are currently executing. */
  isIdle(): boolean {
    return this.active.size === 0;
  }

  /** Number of handlers currently running for a type. */
  inflightFor(type: JobType): number {
    return this.inFlight.get(type) ?? 0;
  }

  /**
   * Claim and start due work up to each type's concurrency cap, and fail any due
   * job whose type has no handler. Starts handlers without awaiting them; pair
   * with `settle()` (or use `runOnce()` for both). Returns the count started.
   */
  dispatch(): number {
    const now = this.clock();
    // A lease protects recovery after a process dies; it is not a local handler
    // timeout. Continuous polling can outlive a lease, so keep genuinely active
    // in-process jobs running while still reclaiming every other expired row.
    reclaimExpiredLeases(this.db, now, [...this.activeJobIds]);
    // Pause (Section 27): do not claim new agent reviews or outbound
    // sends. Ingestion backfills and other housekeeping are unaffected, and
    // already-running handlers are left to finish.
    const paused = this.isPaused();
    let started = 0;

    for (const [type, reg] of this.handlers) {
      if (paused) {
        const cat = categoryOf(type);
        if (cat === 'reviews' || cat === 'sends') continue;
      }
      let guard = 0;
      while ((this.inFlight.get(type) ?? 0) < reg.concurrency && guard < 1000) {
        guard++;
        const job = claimNextJob(this.db, { owner: this.owner, now, leaseMs: this.leaseMs, type });
        if (!job) break;
        this.startHandler(type, reg.run, job);
        started++;
      }
    }

    // Drain due jobs whose type has no handler — fail them terminally so they
    // do not block the queue or retry forever.
    const registered = this.registeredTypes();
    let unknownGuard = 0;
    while (unknownGuard < 1000) {
      unknownGuard++;
      const job = claimNextJob(this.db, {
        owner: this.owner,
        now,
        leaseMs: this.leaseMs,
        excludeTypes: registered,
      });
      if (!job) break;
      failJob(this.db, {
        id: job.id,
        error: new PermanentJobError(`no handler registered for job type: ${job.type}`),
        now,
      });
    }

    return started;
  }

  private startHandler(
    type: JobType,
    run: (job: JobRow) => Promise<void>,
    job: JobRow,
  ): void {
    this.inFlight.set(type, (this.inFlight.get(type) ?? 0) + 1);
    this.activeJobIds.add(job.id);
    // Holder lets the handler remove its own promise from `active` inside its
    // finally — which runs before the promise settles — without a
    // use-before-assignment on the promise itself. settle()/isIdle() therefore
    // never observe a stale entry.
    const holder: { promise: Promise<void> } = { promise: undefined as unknown as Promise<void> };
    holder.promise = (async () => {
      try {
        await run(job);
        completeJob(this.db, job.id, this.clock());
      } catch (err) {
        const failedAt = this.clock();
        if (err instanceof ContinueJobError) {
          continueJobAfterProgress(
            this.db,
            job.id,
            failedAt + Math.max(1, err.retryAfterMs),
            failedAt,
          );
        } else if (err instanceof DeferJobError) {
          deferJob(this.db, job.id, failedAt + Math.max(1, err.retryAfterMs), err.message, failedAt);
        } else {
          failJob(this.db, { id: job.id, error: err, now: failedAt });
        }
      } finally {
        this.inFlight.set(type, Math.max(0, (this.inFlight.get(type) ?? 1) - 1));
        this.activeJobIds.delete(job.id);
        this.active.delete(holder.promise);
        // Refill the newly available per-type slot immediately when the polling
        // loop is active. This is also what lets the loop observe other newly
        // queued work without waiting for every unrelated handler to settle.
        this.wake();
      }
    })();
    this.active.add(holder.promise);
  }

  /** Await every in-flight handler. */
  async settle(): Promise<void> {
    if (this.active.size === 0) return;
    await Promise.allSettled(this.active);
  }

  /** Dispatch once and wait for everything started to finish. */
  async runOnce(): Promise<void> {
    this.dispatch();
    await this.settle();
  }

  /** Begin the polling loop. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.dispatch();
      if (!this.running) break;
      // Keep polling while handlers are active. A long historical/model handler
      // must not prevent a newly queued direct answer from being claimed. Handler
      // completion and stop() wake this wait early.
      await this.waitForWake();
    }
  }

  private async waitForWake(): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false;
      const wake = () => {
        if (done) return;
        done = true;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.pollWake = null;
        resolve();
      };
      this.pollWake = wake;
      this.pollTimer = setTimeout(wake, this.pollIntervalMs);
    });
  }

  /** Prompt an active polling loop to run another dispatch round. */
  wake(): void {
    this.pollWake?.();
  }

  /** Stop claiming new work. In-flight handlers continue until settled. */
  stop(): void {
    this.running = false;
    this.wake();
  }

  /**
   * Wait for in-flight handlers to finish after `stop()`, bounded by the
   * shutdown timeout. Returns true when everything settled cleanly. Running
   * jobs whose leases later expire are recovered on the next process start
   * (Section 34).
   */
  async waitForShutdown(): Promise<boolean> {
    this.stop();
    if (this.active.size === 0) return true;
    const settled = Promise.race([
      this.settle().then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), this.shutdownTimeoutMs),
      ),
    ]);
    return settled;
  }
}
