import { describe, it, expect } from 'vitest';
import {
  ModelHealthTracker,
  OrgDayBudget,
  ModelBudgetGate,
  evaluateModelGate,
  classifyModelError,
  DEFAULT_MODEL_HEALTH,
  type ModelFailureClass,
} from '../../src/agent/budget.js';
import { nextOrgDayStartMs, orgDayStartMs } from '../../src/agent/cooldowns.js';

/**
 * Model outage and daily-budget gating (Sections 21.4, 45).
 *
 * Acceptance: provider-outage and budget fixtures keep episodes queued, block
 * outbound generation, keep liveness healthy, and recover automatically.
 */

const TZ = 'UTC';
const NOW = 1_700_000_001_000;
const NEXT_DAY = nextOrgDayStartMs(NOW, TZ);

describe('classifyModelError', () => {
  it.each([
    [{ status: 429 }, 'transient'],
    [{ status: 500 }, 'transient'],
    [{ status: 503 }, 'transient'],
    [{ message: 'rate limit exceeded' }, 'transient'],
    [{ message: 'Request timed out' }, 'transient'],
    [{ message: 'fetch failed: ECONNRESET' }, 'transient'],
    [{ status: 401 }, 'auth'],
    [{ status: 403 }, 'auth'],
    [{ status: 400, message: 'bad request' }, 'other'],
  ] as const)('classifies %j as %s', (err, expected) => {
    expect(classifyModelError(err)).toBe(expected);
  });
});

describe('ModelHealthTracker', () => {
  it('is healthy until the failure threshold is reached', () => {
    const t = new ModelHealthTracker({ failureThreshold: 3, outageCooldownMs: 60_000 });
    expect(t.status(NOW)).toBe('healthy');
    t.recordFailure('transient', NOW);
    t.recordFailure('transient', NOW);
    expect(t.status(NOW)).toBe('healthy'); // two failures, below threshold
    t.recordFailure('transient', NOW);
    expect(t.status(NOW)).toBe('degraded'); // third trips the outage
    expect(t.retryAfterMs(NOW)).toBe(60_000);
  });

  it('recovers automatically once the cooldown elapses', () => {
    const t = new ModelHealthTracker({ failureThreshold: 2, outageCooldownMs: 60_000 });
    t.recordFailure('transient', NOW);
    t.recordFailure('transient', NOW);
    expect(t.status(NOW)).toBe('degraded');
    expect(t.status(NOW + 59_999)).toBe('degraded');
    expect(t.status(NOW + 60_000)).toBe('healthy'); // cooldown expired → probe may run
  });

  it('clears the streak on a single success', () => {
    const t = new ModelHealthTracker({ failureThreshold: 2, outageCooldownMs: 60_000 });
    t.recordFailure('transient', NOW);
    t.recordFailure('transient', NOW);
    expect(t.status(NOW)).toBe('degraded');
    t.recordSuccess(NOW);
    expect(t.status(NOW)).toBe('healthy');
    // A subsequent failure no longer instantly degrades (streak was reset).
    t.recordFailure('transient', NOW);
    expect(t.status(NOW)).toBe('healthy');
  });
});

describe('OrgDayBudget', () => {
  it('is never exhausted when no daily cap is configured', () => {
    const b = new OrgDayBudget({ dailyBudgetUsd: null, timeZone: TZ }, NOW);
    expect(b.isBudgetEnabled()).toBe(false);
    b.recordSpend(1_000_000, NOW);
    expect(b.isExhausted(NOW)).toBe(false);
    expect(b.remaining(NOW)).toBeNull();
  });

  it('accumulates spend and reports exhaustion at the cap', () => {
    const b = new OrgDayBudget({ dailyBudgetUsd: 5, timeZone: TZ }, NOW);
    expect(b.isExhausted(NOW)).toBe(false);
    expect(b.remaining(NOW)).toBe(5);
    b.recordSpend(3, NOW);
    expect(b.remaining(NOW)).toBe(2);
    expect(b.isExhausted(NOW)).toBe(false);
    b.recordSpend(2, NOW);
    expect(b.isExhausted(NOW)).toBe(true);
    expect(b.remaining(NOW)).toBe(0);
  });

  it('resets at the next organization-day boundary (automatic recovery)', () => {
    const b = new OrgDayBudget({ dailyBudgetUsd: 1, timeZone: TZ }, NOW);
    b.recordSpend(1, NOW);
    expect(b.isExhausted(NOW)).toBe(true);
    // Same org-day, just later: still exhausted.
    expect(b.isExhausted(NEXT_DAY - 1)).toBe(true);
    // Cross into the next org-day: budget refreshes.
    expect(orgDayStartMs(NEXT_DAY + 1, TZ)).toBe(NEXT_DAY);
    expect(b.isExhausted(NEXT_DAY + 1)).toBe(false);
    expect(b.spent(NEXT_DAY + 1)).toBe(0);
  });

  it('ignores non-positive or non-finite spend', () => {
    const b = new OrgDayBudget({ dailyBudgetUsd: 1, timeZone: TZ }, NOW);
    b.recordSpend(-5, NOW);
    b.recordSpend(NaN, NOW);
    b.recordSpend(0, NOW);
    expect(b.spent(NOW)).toBe(0);
  });
});

describe('evaluateModelGate', () => {
  it('allows when healthy with budget remaining', () => {
    expect(
      evaluateModelGate({
        health: 'healthy',
        budgetExhausted: false,
        budgetEnabled: true,
        healthRetryMs: 0,
        msUntilNextDay: 1000,
      }),
    ).toEqual({ allow: true, degraded: false });
  });

  it('blocks on outage with a retry hint (provider precedence over budget)', () => {
    const d = evaluateModelGate({
      health: 'degraded',
      budgetExhausted: true,
      budgetEnabled: true,
      healthRetryMs: 60_000,
      msUntilNextDay: 1000,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('outage'); // outage wins over budget
    expect(d.degraded).toBe(true);
    expect(d.retryAfterMs).toBe(60_000);
  });

  it('blocks on an exhausted budget when the provider is healthy', () => {
    const d = evaluateModelGate({
      health: 'healthy',
      budgetExhausted: true,
      budgetEnabled: true,
      healthRetryMs: 0,
      msUntilNextDay: 7_200_000,
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('budget_exhausted');
    expect(d.retryAfterMs).toBe(7_200_000);
  });

  it('ignores budget exhaustion when no cap is configured', () => {
    expect(
      evaluateModelGate({
        health: 'healthy',
        budgetExhausted: true,
        budgetEnabled: false,
        healthRetryMs: 0,
        msUntilNextDay: 1000,
      }),
    ).toEqual({ allow: true, degraded: false });
  });
});

describe('ModelBudgetGate end-to-end — outage fixture', () => {
  it('keeps episodes queued, blocks generation, stays live, and auto-recovers', () => {
    const gate = new ModelBudgetGate(
      { dailyBudgetUsd: null, timeZone: TZ, health: { failureThreshold: 3, outageCooldownMs: 60_000 } },
      NOW,
    );

    // Provider starts failing: ingestion continues, but model work is gated.
    gate.recordModelFailure('transient', NOW);
    gate.recordModelFailure('transient', NOW + 1_000);
    // Two failures: still allowed (below threshold) — a single retry may run.
    expect(gate.evaluate(NOW + 2_000).allow).toBe(true);
    gate.recordModelFailure('transient', NOW + 3_000); // third failure → outage
    const blocked = gate.evaluate(NOW + 4_000);
    expect(blocked.allow).toBe(false); // outbound generation blocked
    expect(blocked.reason).toBe('outage');
    expect(blocked.retryAfterMs).toBeGreaterThan(0); // episode re-enqueued, not discarded
    expect(() => gate.evaluate(NOW + 4_000)).not.toThrow(); // liveness stays healthy

    // Automatic recovery: after the cooldown, a probe is allowed again.
    const recovered = gate.evaluate(NOW + 4_000 + 60_000);
    expect(recovered.allow).toBe(true);

    // A successful probe clears the outage for good.
    gate.recordModelSuccess(NOW + 4_000 + 60_000);
    expect(gate.evaluate(NOW + 4_000 + 60_001).degraded).toBe(false);
  });

  it('counts every failure class toward the outage', () => {
    const gate = new ModelBudgetGate(
      { dailyBudgetUsd: null, timeZone: TZ, health: { failureThreshold: 2, outageCooldownMs: 30_000 } },
      NOW,
    );
    for (const cls of ['transient', 'auth'] as ModelFailureClass[]) {
      gate.recordModelFailure(cls, NOW);
    }
    expect(gate.evaluate(NOW).reason).toBe('outage');
  });
});

describe('ModelBudgetGate end-to-end — budget fixture', () => {
  it('blocks generation when the daily cap is reached and clears next org-day', () => {
    const gate = new ModelBudgetGate(
      { dailyBudgetUsd: 2, timeZone: TZ, health: DEFAULT_MODEL_HEALTH },
      NOW,
    );

    gate.recordSpend(1.5, NOW);
    expect(gate.evaluate(NOW).allow).toBe(true);
    gate.recordSpend(0.5, NOW); // cap reached
    const blocked = gate.evaluate(NOW + 1_000);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe('budget_exhausted');
    expect(blocked.retryAfterMs).toBeGreaterThan(0); // held until next org-day
    expect(() => gate.evaluate(NOW + 1_000)).not.toThrow(); // liveness healthy

    // Ingestion-independent recovery at the next org-day boundary.
    expect(gate.evaluate(NEXT_DAY + 1).allow).toBe(true);
  });

  it('outage takes precedence over an exhausted budget', () => {
    const gate = new ModelBudgetGate(
      { dailyBudgetUsd: 1, timeZone: TZ, health: { failureThreshold: 1, outageCooldownMs: 60_000 } },
      NOW,
    );
    gate.recordSpend(5, NOW); // budget exhausted
    gate.recordModelFailure('transient', NOW); // provider also down
    const d = gate.evaluate(NOW);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('outage');
  });
});
