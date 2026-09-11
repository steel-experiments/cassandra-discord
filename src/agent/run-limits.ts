import type { AgentConfig } from '../config.js';
import type { RunLimits } from './runtime.js';

/**
 * The subset of run limits supplied by production configuration. `maxTurns`
 * remains the runtime's fixed safety default because it has no environment
 * setting in the Section 35 contract.
 *
 * Keeping this as named `RunLimits` keys makes a config/runtime rename a
 * compile-time failure instead of silently passing an unused similarly named
 * property through `Partial<RunLimits>`.
 */
export type ConfiguredRunLimits = Pick<
  RunLimits,
  'wallClockMs' | 'maxToolCalls' | 'charBudget'
>;

/** Convert the validated production config shape to the agent runtime shape. */
export function configuredRunLimits(config: AgentConfig): ConfiguredRunLimits {
  return {
    wallClockMs: config.timeoutSeconds * 1_000,
    maxToolCalls: config.maxToolCalls,
    charBudget: config.maxRetrievedCharacters,
  } satisfies ConfiguredRunLimits;
}

/**
 * Clamp a configured model execution cap to an interactive request's remaining
 * end-to-end deadline. Zero means the request is already expired and the model
 * must not start.
 */
export function deadlineBoundWallClockMs(
  configuredWallClockMs: number,
  requestDeadlineAtMs: number,
  nowMs: number,
): number {
  if (
    !Number.isFinite(configuredWallClockMs)
    || !Number.isFinite(requestDeadlineAtMs)
    || !Number.isFinite(nowMs)
    || configuredWallClockMs <= 0
  ) {
    return 0;
  }
  return Math.max(0, Math.min(configuredWallClockMs, requestDeadlineAtMs - nowMs));
}
