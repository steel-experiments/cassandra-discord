import type { ToolCallSummary } from './ledger.js';

export interface TurnTraceSummary {
  version: 1 | 2;
  turnIndex: number; startedAtMs: number; modelEndedAtMs: number | null; endedAtMs: number;
  modelDurationMs: number | null; durationMs: number; inputTokens: number; outputTokens: number;
  costUsd: number; stopReason: string | null; incomplete: boolean;
  uncachedInputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; cacheWrite1hTokens: number | null;
  reasoningTokens: number | null; providerTotalTokens: number | null;
  uncachedInputCostUsd: number | null; outputCostUsd: number | null;
  cacheReadCostUsd: number | null; cacheWriteCostUsd: number | null;
}
export interface TraceRow {
  kind: 'model' | 'tool'; label: string; turnIndex: number; startPct: number;
  widthPct: number; durationMs: number; tool?: ToolCallSummary; turn?: TurnTraceSummary;
}
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function optionalFinite(value: unknown, integer: boolean): { valid: boolean; value: number | null } {
  if (value === null) return { valid: true, value: null };
  const parsed = integer ? finite(value) : finiteNumber(value);
  return { valid: parsed !== null, value: parsed };
}
export function parseModelTurns(json: string | null | undefined): TurnTraceSummary[] {
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 20).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const turnIndex = finite(row.turnIndex), startedAtMs = finite(row.startedAtMs);
    const endedAtMs = finite(row.endedAtMs), durationMs = finite(row.durationMs);
    if ((row.version !== 1 && row.version !== 2) || turnIndex === null || startedAtMs === null || endedAtMs === null || durationMs === null) return [];
    const legacy = row.version === 1;
    const requiredTokens = legacy ? null : {
      uncachedInputTokens: finite(row.uncachedInputTokens),
      cacheReadTokens: finite(row.cacheReadTokens),
      cacheWriteTokens: finite(row.cacheWriteTokens),
      providerTotalTokens: finite(row.providerTotalTokens),
    };
    const requiredCosts = legacy ? null : {
      uncachedInputCostUsd: finiteNumber(row.uncachedInputCostUsd),
      outputCostUsd: finiteNumber(row.outputCostUsd),
      cacheReadCostUsd: finiteNumber(row.cacheReadCostUsd),
      cacheWriteCostUsd: finiteNumber(row.cacheWriteCostUsd),
    };
    const cacheWrite1h = legacy ? { valid: true, value: null } : optionalFinite(row.cacheWrite1hTokens, true);
    const reasoning = legacy ? { valid: true, value: null } : optionalFinite(row.reasoningTokens, true);
    if (!legacy && (
      Object.values(requiredTokens!).some((value) => value === null)
      || Object.values(requiredCosts!).some((value) => value === null)
      || !cacheWrite1h.valid
      || !reasoning.valid
    )) return [];
    return [{ version: row.version, turnIndex, startedAtMs, modelEndedAtMs: finite(row.modelEndedAtMs), endedAtMs,
      modelDurationMs: finite(row.modelDurationMs), durationMs, inputTokens: finite(row.inputTokens) ?? 0,
      outputTokens: finite(row.outputTokens) ?? 0,
      costUsd: finiteNumber(row.costUsd) ?? 0,
      uncachedInputTokens: requiredTokens?.uncachedInputTokens ?? null,
      cacheReadTokens: requiredTokens?.cacheReadTokens ?? null,
      cacheWriteTokens: requiredTokens?.cacheWriteTokens ?? null,
      cacheWrite1hTokens: cacheWrite1h.value,
      reasoningTokens: reasoning.value,
      providerTotalTokens: requiredTokens?.providerTotalTokens ?? null,
      uncachedInputCostUsd: requiredCosts?.uncachedInputCostUsd ?? null,
      outputCostUsd: requiredCosts?.outputCostUsd ?? null,
      cacheReadCostUsd: requiredCosts?.cacheReadCostUsd ?? null,
      cacheWriteCostUsd: requiredCosts?.cacheWriteCostUsd ?? null,
      stopReason: typeof row.stopReason === 'string' ? row.stopReason.slice(0, 40) : null,
      incomplete: row.incomplete === true }];
  });
}
function pct(value: number): number { return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0)); }
export function buildTraceRows(turns: TurnTraceSummary[], tools: ToolCallSummary[], start: number, finish: number | null): TraceRow[] {
  if (!turns.length) return [];
  const end = Math.max(start + 1, finish ?? Math.max(...turns.map((turn) => turn.endedAtMs)));
  const span = Math.max(1, end - start);
  const geometry = (at: number, duration: number) => ({ startPct: pct(((at - start) / span) * 100), widthPct: pct((duration / span) * 100) });
  const rows: TraceRow[] = [];
  for (const turn of turns) {
    const duration = turn.modelDurationMs ?? 0;
    rows.push({ kind: 'model', label: `Turn ${turn.turnIndex} · model`, turnIndex: turn.turnIndex, ...geometry(turn.startedAtMs, duration), durationMs: duration, turn });
    for (const tool of tools.filter((call) => call.turnIndex === turn.turnIndex)) {
      if (tool.startedAtMs === null || tool.durationMs === null) continue;
      rows.push({ kind: 'tool', label: tool.toolName, turnIndex: turn.turnIndex, ...geometry(tool.startedAtMs, tool.durationMs), durationMs: tool.durationMs, tool });
    }
  }
  return rows;
}
