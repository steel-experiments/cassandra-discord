import type { Usage } from '@earendil-works/pi-ai';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number | null;
  reasoningTokens: number | null;
  providerTotalTokens: number;
  uncachedInputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
}

export type NormalizedTurnUsage = AgentRunUsage;

const MAX_VALUE = Number.MAX_SAFE_INTEGER;

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_VALUE, Math.floor(value))
    : 0;
}

function optionalToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_VALUE, Math.floor(value))
    : null;
}

function cost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_VALUE, value)
    : 0;
}

function add(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? Math.min(MAX_VALUE, sum) : MAX_VALUE;
}

export function emptyAgentRunUsage(): AgentRunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    providerTotalTokens: 0,
    uncachedInputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWriteCostUsd: 0,
  };
}

export function normalizeTurnUsage(usage: Usage | null | undefined): NormalizedTurnUsage {
  const uncachedInputTokens = token(usage?.input);
  const cacheReadTokens = token(usage?.cacheRead);
  const cacheWriteTokens = token(usage?.cacheWrite);
  return {
    inputTokens: add(add(uncachedInputTokens, cacheReadTokens), cacheWriteTokens),
    outputTokens: token(usage?.output),
    costUsd: cost(usage?.cost?.total),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: optionalToken(usage?.cacheWrite1h),
    reasoningTokens: optionalToken(usage?.reasoning),
    providerTotalTokens: token(usage?.totalTokens),
    uncachedInputCostUsd: cost(usage?.cost?.input),
    outputCostUsd: cost(usage?.cost?.output),
    cacheReadCostUsd: cost(usage?.cost?.cacheRead),
    cacheWriteCostUsd: cost(usage?.cost?.cacheWrite),
  };
}

export interface UsageAccumulator {
  add(usage: Usage): void;
  finalize(): AgentRunUsage;
}

export function createUsageAccumulator(): UsageAccumulator {
  const total = emptyAgentRunUsage();
  let usageTurns = 0;
  let cacheWrite1hComplete = true;
  let reasoningComplete = true;

  return {
    add(usage) {
      const turn = normalizeTurnUsage(usage);
      usageTurns += 1;
      total.inputTokens = add(total.inputTokens, turn.inputTokens);
      total.outputTokens = add(total.outputTokens, turn.outputTokens);
      total.costUsd = add(total.costUsd, turn.costUsd);
      total.uncachedInputTokens = add(total.uncachedInputTokens, turn.uncachedInputTokens);
      total.cacheReadTokens = add(total.cacheReadTokens, turn.cacheReadTokens);
      total.cacheWriteTokens = add(total.cacheWriteTokens, turn.cacheWriteTokens);
      total.providerTotalTokens = add(total.providerTotalTokens, turn.providerTotalTokens);
      total.uncachedInputCostUsd = add(total.uncachedInputCostUsd, turn.uncachedInputCostUsd);
      total.outputCostUsd = add(total.outputCostUsd, turn.outputCostUsd);
      total.cacheReadCostUsd = add(total.cacheReadCostUsd, turn.cacheReadCostUsd);
      total.cacheWriteCostUsd = add(total.cacheWriteCostUsd, turn.cacheWriteCostUsd);

      if (turn.cacheWrite1hTokens === null) cacheWrite1hComplete = false;
      else if (cacheWrite1hComplete) {
        total.cacheWrite1hTokens = add(total.cacheWrite1hTokens ?? 0, turn.cacheWrite1hTokens);
      }
      if (turn.reasoningTokens === null) reasoningComplete = false;
      else if (reasoningComplete) {
        total.reasoningTokens = add(total.reasoningTokens ?? 0, turn.reasoningTokens);
      }
    },
    finalize() {
      return {
        ...total,
        cacheWrite1hTokens: usageTurns > 0 && cacheWrite1hComplete
          ? (total.cacheWrite1hTokens ?? 0)
          : null,
        reasoningTokens: usageTurns > 0 && reasoningComplete
          ? (total.reasoningTokens ?? 0)
          : null,
      };
    },
  };
}
