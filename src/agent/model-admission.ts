/** Model work classes used by the process-local provider concurrency gate. */
export type ModelAdmissionClass = 'direct_answer' | 'background';

/** Maximum time an interactive request may spend queued for a provider slot. */
export const DIRECT_ANSWER_MODEL_SLOT_WAIT_MS = 60_000;

/**
 * Bound provider-slot waiting by both the queue SLA and the request's absolute
 * deadline. Missing deadlines retain the standalone queue bound; malformed or
 * elapsed deadlines fail closed at zero.
 */
export function directAnswerAdmissionWaitMs(
  requestDeadlineAtMs: number | undefined,
  nowMs: number,
): number {
  if (requestDeadlineAtMs === undefined) return DIRECT_ANSWER_MODEL_SLOT_WAIT_MS;
  if (!Number.isFinite(requestDeadlineAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(
    0,
    Math.min(DIRECT_ANSWER_MODEL_SLOT_WAIT_MS, requestDeadlineAtMs - nowMs),
  );
}

/**
 * Content-free deadline signal for an interactive run that waited too long for
 * a provider slot. The direct-answer handler may turn this category into a
 * technical fallback without exposing Discord or model content.
 */
export class ModelAdmissionTimeoutError extends Error {
  readonly category = 'admission_timeout' as const;

  constructor(readonly retryAfterMs?: number) {
    super('direct-answer model admission deadline exceeded');
    this.name = 'ModelAdmissionTimeoutError';
  }
}

interface Waiter {
  readonly admissionClass: ModelAdmissionClass;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: ModelAdmissionTimeoutError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export interface ModelAdmissionOptions {
  /** Maximum simultaneous provider calls. */
  capacity: number;
  /**
   * Maximum direct-answer handoffs while background work is also queued before
   * one background waiter is admitted. Defaults to three.
   */
  directBurstLimit?: number;
}

export interface AcquireModelSlotOptions {
  /** Optional bounded queue wait. Omit for durable background work. */
  timeoutMs?: number;
}

/**
 * A non-preemptive, bounded-fair priority semaphore for provider calls.
 *
 * Running background calls retain their slots. At release, a queued direct
 * answer goes before an older background waiter, but a sustained direct-answer
 * stream yields after `directBurstLimit` contested handoffs. This preserves the
 * configured provider concurrency exactly; it does not reserve an extra
 * interactive slot.
 */
export class ModelAdmissionController {
  private readonly capacity: number;
  private readonly directBurstLimit: number;
  private active = 0;
  private contestedDirectHandoffs = 0;
  private readonly directWaiters: Waiter[] = [];
  private readonly backgroundWaiters: Waiter[] = [];

  constructor(options: ModelAdmissionOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error('model admission capacity must be a positive integer');
    }
    const directBurstLimit = options.directBurstLimit ?? 3;
    if (!Number.isInteger(directBurstLimit) || directBurstLimit < 1) {
      throw new Error('direct-answer burst limit must be a positive integer');
    }
    this.capacity = options.capacity;
    this.directBurstLimit = directBurstLimit;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedDirectCount(): number {
    return this.directWaiters.filter((waiter) => !waiter.settled).length;
  }

  get queuedBackgroundCount(): number {
    return this.backgroundWaiters.filter((waiter) => !waiter.settled).length;
  }

  /** Wait for a slot and return an idempotent release function. */
  acquire(
    admissionClass: ModelAdmissionClass,
    options: AcquireModelSlotOptions = {},
  ): Promise<() => void> {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new Error('model admission timeout must be non-negative'));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        admissionClass,
        resolve,
        reject,
        timer: null,
        settled: false,
      };
      const queue = admissionClass === 'direct_answer'
        ? this.directWaiters
        : this.backgroundWaiters;
      queue.push(waiter);

      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.timer = null;
          waiter.reject(new ModelAdmissionTimeoutError(timeoutMs));
        }, timeoutMs);
      }

      this.pump();
    });
  }

  private pump(): void {
    this.dropSettledHeads(this.directWaiters);
    this.dropSettledHeads(this.backgroundWaiters);
    while (this.active < this.capacity) {
      const waiter = this.nextWaiter();
      if (!waiter) return;
      if (waiter.settled) continue;

      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.timer = null;
      this.active += 1;

      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.pump();
      });

      this.dropSettledHeads(this.directWaiters);
      this.dropSettledHeads(this.backgroundWaiters);
    }
  }

  private nextWaiter(): Waiter | undefined {
    this.dropSettledHeads(this.directWaiters);
    this.dropSettledHeads(this.backgroundWaiters);
    const hasDirect = this.directWaiters.length > 0;
    const hasBackground = this.backgroundWaiters.length > 0;

    if (hasDirect && hasBackground) {
      if (this.contestedDirectHandoffs >= this.directBurstLimit) {
        this.contestedDirectHandoffs = 0;
        return this.backgroundWaiters.shift();
      }
      this.contestedDirectHandoffs += 1;
      return this.directWaiters.shift();
    }

    // No class is being starved, so a previous contested burst does not carry
    // forward and penalize a later unrelated arrival.
    this.contestedDirectHandoffs = 0;
    return hasDirect ? this.directWaiters.shift() : this.backgroundWaiters.shift();
  }

  private dropSettledHeads(queue: Waiter[]): void {
    while (queue[0]?.settled) queue.shift();
  }
}
