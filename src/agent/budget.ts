import { orgDayStartMs, nextOrgDayStartMs } from './cooldowns.js';

/**
 * Model outage and daily-cost gating (Sections 21.4, 45).
 *
 * Discord ingestion never depends on the model provider, so a provider outage
 * or an exhausted daily budget must pause only model work — reviews stay queued,
 * no outbound generation runs, liveness stays healthy, and recovery is automatic
 * once the provider responds or the next organization-day begins. This module
 * owns that decision; the review handler consults {@link ModelBudgetGate.evaluate}
 * before any model call and feeds outcomes back via `recordModelFailure` /
 * `recordModelSuccess` / `recordSpend`.
 */

export type ModelHealthStatus = 'healthy' | 'degraded';

/** Coarse classification of a provider failure (before any redaction). */
export type ModelFailureClass = 'transient' | 'auth' | 'other';

export interface ModelHealthConfig {
  /** Consecutive failures before the provider is considered in outage. */
  failureThreshold: number;
  /** How long the outage (degraded) window lasts before an automatic recovery probe. */
  outageCooldownMs: number;
}

/** Section 21.4: a handful of consecutive failures trip a short outage window. */
export const DEFAULT_MODEL_HEALTH: ModelHealthConfig = {
  failureThreshold: 3,
  outageCooldownMs: 60_000,
};

/**
 * Classify a raw provider error into a failure class. Status codes and a small
 * set of message substrings mark transient (retryable) failures; 401/403 mark
 * an auth/config problem; anything else is treated as an unknown failure. Every
 * class counts toward the outage threshold — a provider that fails for any
 * reason is not available for outbound generation.
 */
export function classifyModelError(error: {
  message?: string;
  status?: number;
  name?: string;
}): ModelFailureClass {
  const status = error.status;
  if (status === 401 || status === 403) return 'auth';
  const transientStatus =
    status !== undefined && [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
  const msg = (error.message || '').toLowerCase();
  const transientMsg =
    /rate limit|too many requests|timeout|timed out|econnreset|enotfound|fetch failed|network|temporarily|overloaded|capacity|service unavailable|retry/.test(
      msg,
    );
  if (transientStatus || transientMsg) return 'transient';
  return 'other';
}

/**
 * Tracks consecutive provider failures and exposes a self-healing degraded
 * window. After {@link ModelHealthConfig.failureThreshold} consecutive failures
 * the provider is `degraded` until {@link ModelHealthConfig.outageCooldownMs}
 * elapses, at which point `status` flips back to `healthy` so a recovery probe
 * may run — automatic recovery. A single success clears the streak immediately.
 */
export class ModelHealthTracker {
  private consecutiveFailures = 0;
  private outageUntilMs = 0;

  constructor(private readonly config: ModelHealthConfig = DEFAULT_MODEL_HEALTH) {}

  recordFailure(_cls: ModelFailureClass, now: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.outageUntilMs = now + this.config.outageCooldownMs;
    }
  }

  recordSuccess(_now: number): void {
    this.consecutiveFailures = 0;
    this.outageUntilMs = 0;
  }

  status(now: number): ModelHealthStatus {
    return now < this.outageUntilMs ? 'degraded' : 'healthy';
  }

  /** Milliseconds until the degraded window closes (0 when healthy). */
  retryAfterMs(now: number): number {
    return Math.max(0, this.outageUntilMs - now);
  }

  /** Current consecutive-failure count (diagnostics / readiness). */
  get consecutiveFailuresSeen(): number {
    return this.consecutiveFailures;
  }
}

export interface OrgDayBudgetConfig {
  /** Null disables the daily cap (Section 45: the budget is optional). */
  dailyBudgetUsd: number | null;
  timeZone: string;
}

/**
 * Accumulates provider spend against an optional daily cap, scoped to the
 * organization day (Section 45). Spend resets automatically when the org-day
 * boundary crosses, so an exhausted budget clears at the start of the next day
 * without operator intervention. When the cap is null the budget is never
 * exhausted.
 */
export class OrgDayBudget {
  private dayStartMs: number;
  private spentToday = 0;

  constructor(private readonly config: OrgDayBudgetConfig, now: number) {
    this.dayStartMs = orgDayStartMs(now, config.timeZone);
  }

  isBudgetEnabled(): boolean {
    return this.config.dailyBudgetUsd !== null;
  }

  private ensureDay(now: number): void {
    const start = orgDayStartMs(now, this.config.timeZone);
    if (start !== this.dayStartMs) {
      this.dayStartMs = start;
      this.spentToday = 0;
    }
  }

  recordSpend(costUsd: number, _now: number): void {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    this.ensureDay(_now);
    this.spentToday += costUsd;
  }

  spent(now: number): number {
    this.ensureDay(now);
    return this.spentToday;
  }

  remaining(now: number): number | null {
    if (this.config.dailyBudgetUsd === null) return null;
    return Math.max(0, this.config.dailyBudgetUsd - this.spent(now));
  }

  isExhausted(now: number): boolean {
    if (this.config.dailyBudgetUsd === null) return false;
    return this.spent(now) >= this.config.dailyBudgetUsd;
  }

  /** Milliseconds until the next org-day boundary (when an exhausted cap resets). */
  msUntilNextDay(now: number): number {
    return Math.max(1, nextOrgDayStartMs(now, this.config.timeZone) - now);
  }
}

export type ModelGateBlockReason = 'outage' | 'budget_exhausted';

export interface ModelGateDecision {
  /** True when a model run may proceed now. */
  allow: boolean;
  /** Present when blocked; the job is re-enqueued, never discarded. */
  reason?: ModelGateBlockReason;
  /** When blocked, how long to wait before the next probe (ms). */
  retryAfterMs?: number;
  /** True when the gate is holding model work (readiness reports degraded). */
  degraded: boolean;
}

/**
 * Pure decision: a model run is allowed only when the provider is healthy and
 * the daily budget has capacity. A provider outage takes precedence over budget
 * (a down provider spends nothing). When blocked the decision always carries a
 * `retryAfterMs` so the caller re-enqueues rather than dropping the job.
 */
export function evaluateModelGate(args: {
  health: ModelHealthStatus;
  budgetExhausted: boolean;
  budgetEnabled: boolean;
  healthRetryMs: number;
  msUntilNextDay: number;
}): ModelGateDecision {
  if (args.health === 'degraded') {
    return { allow: false, reason: 'outage', retryAfterMs: args.healthRetryMs, degraded: true };
  }
  if (args.budgetExhausted && args.budgetEnabled) {
    return { allow: false, reason: 'budget_exhausted', retryAfterMs: args.msUntilNextDay, degraded: true };
  }
  return { allow: true, degraded: false };
}

export interface ModelBudgetGateConfig {
  health?: ModelHealthConfig;
  dailyBudgetUsd: number | null;
  timeZone: string;
}

/**
 * Combined facade for the review handler: holds the health tracker and the
 * org-day budget and answers "may a model run start now?" Callers feed every
 * model outcome back so the gate self-heals on success and re-arms on failure.
 */
export class ModelBudgetGate {
  readonly health: ModelHealthTracker;
  readonly budget: OrgDayBudget;

  constructor(config: ModelBudgetGateConfig, now: number) {
    this.health = new ModelHealthTracker(config.health ?? DEFAULT_MODEL_HEALTH);
    this.budget = new OrgDayBudget(
      { dailyBudgetUsd: config.dailyBudgetUsd, timeZone: config.timeZone },
      now,
    );
  }

  evaluate(now: number): ModelGateDecision {
    return evaluateModelGate({
      health: this.health.status(now),
      budgetExhausted: this.budget.isExhausted(now),
      budgetEnabled: this.budget.isBudgetEnabled(),
      healthRetryMs: Math.max(1, this.health.retryAfterMs(now)),
      msUntilNextDay: this.budget.msUntilNextDay(now),
    });
  }

  recordModelFailure(cls: ModelFailureClass, now: number): void {
    this.health.recordFailure(cls, now);
  }

  recordModelSuccess(now: number): void {
    this.health.recordSuccess(now);
  }

  recordSpend(costUsd: number, now: number): void {
    this.budget.recordSpend(costUsd, now);
  }
}
