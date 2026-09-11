import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  directAnswerAdmissionWaitMs,
  DIRECT_ANSWER_MODEL_SLOT_WAIT_MS,
  ModelAdmissionController,
  ModelAdmissionTimeoutError,
} from '../../src/agent/model-admission.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('model admission priority and fairness', () => {
  it('clamps interactive queue waiting to the absolute request deadline', () => {
    const now = 1_700_000_000_000;
    expect(directAnswerAdmissionWaitMs(undefined, now)).toBe(
      DIRECT_ANSWER_MODEL_SLOT_WAIT_MS,
    );
    expect(directAnswerAdmissionWaitMs(now + 120_000, now)).toBe(60_000);
    expect(directAnswerAdmissionWaitMs(now + 12_345, now)).toBe(12_345);
    expect(directAnswerAdmissionWaitMs(now, now)).toBe(0);
    expect(directAnswerAdmissionWaitMs(now - 1, now)).toBe(0);
    expect(directAnswerAdmissionWaitMs(Number.NaN, now)).toBe(0);
  });

  it('does not preempt an active background call and prefers direct answer at handoff', async () => {
    const gate = new ModelAdmissionController({ capacity: 1, directBurstLimit: 3 });
    const releaseActive = await gate.acquire('background');
    const order: string[] = [];
    const background = gate.acquire('background').then((release) => {
      order.push('background');
      return release;
    });
    const direct = gate.acquire('direct_answer').then((release) => {
      order.push('direct');
      return release;
    });

    await Promise.resolve();
    expect(order).toEqual([]); // running background work was not preempted
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedBackgroundCount).toBe(1);
    expect(gate.queuedDirectCount).toBe(1);

    releaseActive();
    const releaseDirect = await direct;
    expect(order).toEqual(['direct']);
    releaseDirect();
    const releaseBackground = await background;
    expect(order).toEqual(['direct', 'background']);
    releaseBackground();
    expect(gate.activeCount).toBe(0);
  });

  it('yields to a queued background waiter after a bounded contested direct burst', async () => {
    const gate = new ModelAdmissionController({ capacity: 1, directBurstLimit: 2 });
    const releaseActive = await gate.acquire('background');
    const order: string[] = [];
    const queued = (name: string, admissionClass: 'direct_answer' | 'background') =>
      gate.acquire(admissionClass).then((release) => {
        order.push(name);
        return release;
      });
    const background = queued('background', 'background');
    const direct1 = queued('direct-1', 'direct_answer');
    const direct2 = queued('direct-2', 'direct_answer');
    const direct3 = queued('direct-3', 'direct_answer');

    releaseActive();
    (await direct1)();
    (await direct2)();
    (await background)();
    (await direct3)();

    expect(order).toEqual(['direct-1', 'direct-2', 'background', 'direct-3']);
    expect(gate.activeCount).toBe(0);
  });

  it('bounds direct-answer slot waiting with a content-free category', async () => {
    vi.useFakeTimers();
    const gate = new ModelAdmissionController({ capacity: 1 });
    const releaseActive = await gate.acquire('background');
    const waiting = gate.acquire('direct_answer', { timeoutMs: 60_000 });
    const rejected = expect(waiting).rejects.toMatchObject({
      name: 'ModelAdmissionTimeoutError',
      category: 'admission_timeout',
      retryAfterMs: 60_000,
      message: 'direct-answer model admission deadline exceeded',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(gate.queuedDirectCount).toBe(0);

    releaseActive();
    expect(gate.activeCount).toBe(0);
    expect(new ModelAdmissionTimeoutError()).not.toHaveProperty('discordContent');
  });
});
