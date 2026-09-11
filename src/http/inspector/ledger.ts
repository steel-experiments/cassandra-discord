/**
 * The run context ledger (Section 32.6).
 *
 * A character-based allocation view of one agent run: how much of the
 * per-run character budget the run actually consumed, split by source. The
 * unit is characters — the unit the host budgets (60,000 by default) — never
 * estimated tokens. Inputs are the two audit columns every run already
 * persists: `tool_calls_json` (name, accepted, error flag, argument and result
 * character counts) and `retrieval_provenance_json` (charsExposed, charBudget,
 * coverage counts). No prompt body, tool argument, or tool result text is ever
 * read here — counts only.
 *
 * The bar is host-computed SVG: geometry derives from the character counts and
 * fixed enum colors; the two scale labels are the only text and are escaped.
 */

/** Fixed palette, indexed by segment kind — never caller-supplied. */
export const TONES = ['#0969da', '#8250df', '#1a7f37', '#9a6700', '#cf222e', '#57606a', '#8b949e'] as const;

export interface ToolCallSummary {
  toolName: string;
  toolCallId: string;
  sequence: number | null;
  turnIndex: number | null;
  accepted: boolean;
  isError: boolean;
  argsChars: number;
  resultChars: number;
  reservedChars: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  execution: 'executed' | 'blocked' | 'not_executed' | null;
  exposure: {
    messages: Array<{ id: string; fingerprint: string }>;
    memories: Array<{ id: string; fingerprint: string }>;
    truncatedCount: number;
  } | null;
}

export interface ProvenanceSummary {
  charsExposed: number | null;
  charBudget: number | null;
  channelCount: number;
  messageCount: number;
  memoryCount: number;
  hasSnapshot: boolean;
}

export interface LedgerSegment {
  label: string;
  chars: number;
  toneIndex: number;
  toolCallId?: string;
}

export interface Ledger {
  budget: number;
  exposed: number;
  segments: LedgerSegment[];
  free: number;
  overflow: boolean;
}

/** The fallback budget when provenance carries none: the run limit default. */
export const DEFAULT_RUN_CHAR_BUDGET = 60_000;
/** Tool calls rendered per ledger, bounded like every other query. */
const MAX_TOOL_CALLS = 50;

/** Parse `tool_calls_json` defensively; a malformed column yields no rows. */
export function parseToolCalls(json: string | null | undefined): ToolCallSummary[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, MAX_TOOL_CALLS).map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      toolName: typeof e.toolName === 'string' ? e.toolName.slice(0, 60) : 'unknown',
      toolCallId: typeof e.toolCallId === 'string' ? e.toolCallId.slice(0, 128) : '',
      sequence: optionalNonNegative(e.sequence),
      turnIndex: optionalNonNegative(e.turnIndex),
      accepted: e.accepted !== false,
      isError: e.isError === true,
      argsChars: nonNegative(e.argsChars),
      resultChars: nonNegative(e.resultChars),
      reservedChars: e.traceVersion === 1 ? optionalNonNegative(e.reservedChars) : null,
      startedAtMs: optionalNonNegative(e.startedAtMs),
      endedAtMs: optionalNonNegative(e.endedAtMs),
      durationMs: optionalNonNegative(e.durationMs),
      execution: e.execution === 'executed' || e.execution === 'blocked' || e.execution === 'not_executed'
        ? e.execution
        : null,
      exposure: parseExposure(e.exposure),
    };
  });
}

/** Parse `retrieval_provenance_json`; accepts an object or a legacy array. */
export function parseProvenance(json: string | null | undefined): ProvenanceSummary {
  const empty: ProvenanceSummary = {
    charsExposed: null,
    charBudget: null,
    channelCount: 0,
    messageCount: 0,
    memoryCount: 0,
    hasSnapshot: false,
  };
  if (!json) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return empty;
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  // The accumulator persists one provenance object per run; a legacy array is
  // summed defensively. Missing fields stay null and render as unknown.
  let chars: number | null = null;
  let budget: number | null = null;
  let channels = 0;
  let messages = 0;
  let memories = 0;
  let snapshot = false;
  for (const raw of arr.slice(0, 20)) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.charsExposed === 'number' && Number.isFinite(e.charsExposed)) {
      chars = (chars ?? 0) + e.charsExposed;
    }
    if (typeof e.charBudget === 'number' && Number.isFinite(e.charBudget)) {
      budget = e.charBudget;
    }
    if (Array.isArray(e.channels)) channels += e.channels.length;
    if (Array.isArray(e.messageIds)) messages += e.messageIds.length;
    if (Array.isArray(e.memoryIds)) memories += e.memoryIds.length;
    if (e.recentActivitySnapshot && typeof e.recentActivitySnapshot === 'object') snapshot = true;
  }
  return { charsExposed: chars, charBudget: budget, channelCount: channels, messageCount: messages, memoryCount: memories, hasSnapshot: snapshot };
}

function nonNegative(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function optionalNonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function parseExposure(value: unknown): ToolCallSummary['exposure'] {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  const refs = (candidate: unknown): Array<{ id: string; fingerprint: string }> => {
    if (!Array.isArray(candidate)) return [];
    return candidate.slice(0, 200).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      return typeof record.id === 'string' && typeof record.fingerprint === 'string'
        ? [{ id: record.id.slice(0, 128), fingerprint: record.fingerprint.slice(0, 128) }]
        : [];
    });
  };
  return {
    messages: refs(raw.messages),
    memories: refs(raw.memories),
    truncatedCount: nonNegative(raw.truncatedCount),
  };
}

/**
 * Build the ledger from the one authoritative budget total. New traces split
 * it by per-call reservation delta; old/malformed traces render an honest
 * opaque total. Argument/result sizes remain diagnostics only.
 */
export function buildLedger(toolCalls: ToolCallSummary[], provenance: ProvenanceSummary): Ledger {
  const budget = provenance.charBudget ?? DEFAULT_RUN_CHAR_BUDGET;
  const exposed = Math.max(0, provenance.charsExposed ?? 0);
  const segments: LedgerSegment[] = [];
  const enriched = toolCalls.filter((call) => call.reservedChars !== null);
  const reservations = enriched.reduce((sum, call) => sum + (call.reservedChars ?? 0), 0);
  const invalidSplit = enriched.length > 0 && reservations > exposed;
  if (exposed > 0 && (enriched.length === 0 || invalidSplit)) {
    segments.push({
      label: enriched.length === 0
        ? 'retrieved content (legacy total)'
        : 'retrieved content (invalid split)',
      chars: exposed,
      toneIndex: 0,
    });
  } else if (enriched.length > 0) {
    const repeats = new Map<string, number>();
    for (const call of enriched) {
      if (!call.reservedChars) continue;
      const count = (repeats.get(call.toolName) ?? 0) + 1;
      repeats.set(call.toolName, count);
      segments.push({
        label: `${call.toolName} #${count}`,
        chars: call.reservedChars,
        toneIndex: 1 + (segments.length % 5),
        ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
      });
    }
    if (reservations < exposed) {
      segments.push({ label: 'unattributed retrieval', chars: exposed - reservations, toneIndex: 0 });
    }
  }
  const free = Math.max(0, budget - exposed);
  const overflow = exposed > budget;
  if (free > 0 && segments.length > 0) {
    segments.push({ label: 'free budget', chars: free, toneIndex: 6 });
  }
  return { budget, exposed, segments, free, overflow };
}

/** Render the ledger as one horizontal stacked bar in inline SVG. */
export function renderLedgerSvg(ledger: Ledger): string {
  const width = 920;
  const height = 56;
  const padLeft = 8;
  const barY = 18;
  const barHeight = 20;
  const barWidth = width - padLeft * 2;
  const total = Math.max(ledger.budget, ledger.segments.reduce((sum, seg) => sum + seg.chars, 0), 1);
  let x = padLeft;
  const rects: string[] = [];
  for (const seg of ledger.segments) {
    const w = (seg.chars / total) * barWidth;
    if (w < 0.5) continue;
    rects.push(
      `<rect x="${x.toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="${barHeight}" fill="${TONES[seg.toneIndex % TONES.length]}"><title>${escape(seg.label)}: ${seg.chars.toLocaleString('en-US')} chars</title></rect>`,
    );
    x += w;
  }
  if (ledger.overflow) {
    rects.push(
      `<rect x="${padLeft}" y="${barY}" width="${barWidth}" height="${barHeight}" fill="none" stroke="${TONES[4]}" stroke-width="2"/>`,
    );
  }
  return `<svg class="ledger" viewBox="0 0 ${width} ${height}" role="img" aria-label="Character allocation for this run" xmlns="http://www.w3.org/2000/svg">
${rects.join('\n')}
<text x="${padLeft}" y="12" font-size="11" fill="currentColor">0</text>
<text x="${(width - padLeft).toFixed(1)}" y="12" font-size="11" text-anchor="end" fill="currentColor">${escape(ledger.budget.toLocaleString('en-US'))} char budget</text>
</svg>`;
}

/** Escape helper local to this module so the SVG path has no html.ts coupling. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
