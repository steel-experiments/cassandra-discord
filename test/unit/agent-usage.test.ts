import { describe, expect, it } from 'vitest';
import type { Usage } from '@earendil-works/pi-ai';
import {
  createUsageAccumulator,
  emptyAgentRunUsage,
  normalizeTurnUsage,
} from '../../src/agent/usage.js';

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 10,
    output: 8,
    cacheRead: 20,
    cacheWrite: 5,
    cacheWrite1h: 2,
    reasoning: 3,
    totalTokens: 43,
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.5, total: 3.9 },
    ...overrides,
  };
}

describe('agent usage accounting', () => {
  it('maps every Pi field while retaining compatibility totals and subsets', () => {
    expect(normalizeTurnUsage(usage())).toEqual({
      inputTokens: 35,
      outputTokens: 8,
      costUsd: 3.9,
      uncachedInputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      cacheWrite1hTokens: 2,
      reasoningTokens: 3,
      providerTotalTokens: 43,
      uncachedInputCostUsd: 1,
      outputCostUsd: 2,
      cacheReadCostUsd: 0.2,
      cacheWriteCostUsd: 0.5,
    });
  });

  it('aggregates turns without recomputing provider or total-cost authority', () => {
    const accumulator = createUsageAccumulator();
    accumulator.add(usage());
    accumulator.add(usage({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite1h: 1,
      reasoning: 1,
      totalTokens: 99,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 7 },
    }));
    expect(accumulator.finalize()).toEqual({
      inputTokens: 43,
      outputTokens: 10,
      costUsd: 10.9,
      uncachedInputTokens: 11,
      cacheReadTokens: 23,
      cacheWriteTokens: 9,
      cacheWrite1hTokens: 3,
      reasoningTokens: 4,
      providerTotalTokens: 142,
      uncachedInputCostUsd: 1.1,
      outputCostUsd: 2.2,
      cacheReadCostUsd: 0.5,
      cacheWriteCostUsd: 0.9,
    });
  });

  it('distinguishes an optional explicit zero from incomplete reporting', () => {
    const complete = createUsageAccumulator();
    complete.add(usage({ cacheWrite1h: 0, reasoning: 0 }));
    expect(complete.finalize()).toMatchObject({ cacheWrite1hTokens: 0, reasoningTokens: 0 });

    const incomplete = createUsageAccumulator();
    incomplete.add(usage());
    incomplete.add(usage({ cacheWrite1h: undefined, reasoning: undefined }));
    expect(incomplete.finalize()).toMatchObject({ cacheWrite1hTokens: null, reasoningTokens: null });
    expect(emptyAgentRunUsage()).toMatchObject({ cacheWrite1hTokens: null, reasoningTokens: null });
  });

  it('normalizes malformed values without producing negative or non-finite output', () => {
    const malformed = usage({
      input: -1,
      output: Number.NaN,
      cacheRead: Number.POSITIVE_INFINITY,
      cacheWrite: 1.9,
      cacheWrite1h: -1,
      reasoning: Number.NaN,
      totalTokens: -2,
      cost: { input: -1, output: Number.NaN, cacheRead: 2, cacheWrite: 3, total: Number.POSITIVE_INFINITY },
    });
    expect(normalizeTurnUsage(malformed)).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      costUsd: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
      cacheWrite1hTokens: null,
      reasoningTokens: null,
      providerTotalTokens: 0,
      uncachedInputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 2,
      cacheWriteCostUsd: 3,
    });
  });
});
