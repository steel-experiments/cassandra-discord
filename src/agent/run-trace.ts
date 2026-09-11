import type { AgentEvent, AfterToolCallContext } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import type { RetrievalProvenance } from './run-context.js';
import { normalizeTurnUsage } from './usage.js';

export interface ExposureReference { id: string; fingerprint: string }
export interface ToolExposureAudit {
  version: 1;
  truncatedCount: number;
  messages: ExposureReference[];
  memories: ExposureReference[];
}

export interface ToolAuditEntry {
  toolName: string;
  toolCallId: string;
  accepted: boolean;
  blocked: boolean;
  blockReason?: string;
  isError: boolean;
  argsChars: number;
  resultChars: number;
  traceVersion?: 1;
  sequence?: number;
  turnIndex?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  durationMs?: number;
  execution?: 'executed' | 'blocked' | 'not_executed';
  reservedChars?: number;
  exposure?: ToolExposureAudit;
}

export interface ModelTurnAuditEntry {
  version: 2;
  turnIndex: number;
  startedAtMs: number;
  modelEndedAtMs: number | null;
  endedAtMs: number;
  modelDurationMs: number | null;
  durationMs: number;
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
  stopReason: string | null;
  incomplete: boolean;
}

interface MutableTurn { startedAtMs: number; modelEndedAtMs: number | null }
interface MutableTool extends ToolAuditEntry {
  beforeChars: number;
  candidateMessages: string[];
  candidateMemories: string[];
}

const MAX_TURNS = 20;
const MAX_CALLS = 50;
const MAX_EXPOSURES = 200;

function boundedInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length === MAX_EXPOSURES) break;
  }
  return out;
}

function exposureCandidates(toolName: string, details: unknown): { messages: string[]; memories: string[] } {
  if (!details || typeof details !== 'object') return { messages: [], memories: [] };
  const d = details as Record<string, unknown>;
  switch (toolName) {
    case 'search_messages':
    case 'list_recent_messages':
      return { messages: ids(d.resultIds), memories: [] };
    case 'get_message_context':
      return { messages: ids(d.messageIds), memories: [] };
    case 'get_recent_activity_snapshot': {
      const coverage = d.coverage && typeof d.coverage === 'object'
        ? d.coverage as Record<string, unknown>
        : {};
      return { messages: ids(coverage.exposedMessageIds), memories: [] };
    }
    case 'search_memories':
    case 'list_memories':
      return { messages: [], memories: ids(d.resultIds) };
    case 'get_memory_evidence':
      return {
        messages: ids(d.evidenceIds),
        memories: typeof d.memoryId === 'string' ? ids([d.memoryId]) : [],
      };
    default:
      return { messages: [], memories: [] };
  }
}

export class RunTraceRecorder {
  private readonly turns: ModelTurnAuditEntry[] = [];
  private readonly tools: MutableTool[] = [];
  private currentTurn: MutableTurn | null = null;
  private lastTime = 0;

  constructor(
    private readonly clock: () => number,
    private readonly charsExposed: () => number,
  ) {}

  private now(): number {
    const next = boundedInt(this.clock());
    this.lastTime = Math.max(this.lastTime, next);
    return this.lastTime;
  }

  event(event: AgentEvent): void {
    if (event.type === 'turn_start') {
      if (this.currentTurn) this.closeTurn(null, true);
      if (this.turns.length < MAX_TURNS) {
        this.currentTurn = { startedAtMs: this.now(), modelEndedAtMs: null };
      }
      return;
    }
    if (event.type === 'message_end' && this.currentTurn) {
      const message = event.message as { role?: string };
      if (message.role === 'assistant' && this.currentTurn.modelEndedAtMs === null) {
        this.currentTurn.modelEndedAtMs = this.now();
      }
      return;
    }
    if (event.type === 'tool_execution_start') {
      if (this.tools.length >= MAX_CALLS) return;
      const startedAtMs = this.now();
      this.tools.push({
        toolName: boundedString(event.toolName, 80) ?? 'unknown',
        toolCallId: boundedString(event.toolCallId, 128) ?? '',
        accepted: false,
        blocked: false,
        isError: false,
        argsChars: 0,
        resultChars: 0,
        traceVersion: 1,
        sequence: this.tools.length + 1,
        turnIndex: this.turns.length + 1,
        startedAtMs,
        execution: 'not_executed',
        beforeChars: boundedInt(this.charsExposed()),
        candidateMessages: [],
        candidateMemories: [],
      });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const tool = this.findOpenTool(event.toolCallId);
      if (!tool) return;
      const endedAtMs = this.now();
      tool.endedAtMs = endedAtMs;
      tool.durationMs = Math.max(0, endedAtMs - (tool.startedAtMs ?? endedAtMs));
      tool.isError ||= event.isError;
      tool.reservedChars = Math.max(0, boundedInt(this.charsExposed()) - tool.beforeChars);
      return;
    }
    if (event.type === 'turn_end') this.closeTurn(event.message, false);
  }

  before(toolCallId: string, argsChars: number): void {
    const tool = this.findOpenTool(toolCallId);
    if (tool) tool.argsChars = boundedInt(argsChars);
  }

  blocked(entry: ToolAuditEntry): void {
    const tool = this.findOpenTool(entry.toolCallId);
    if (!tool) return;
    tool.accepted = false;
    tool.blocked = true;
    tool.blockReason = boundedString(entry.blockReason, 200) ?? undefined;
    tool.isError = entry.isError;
    tool.argsChars = boundedInt(entry.argsChars);
    tool.resultChars = boundedInt(entry.resultChars);
    tool.execution = 'blocked';
  }

  after(context: AfterToolCallContext, resultChars: number): void {
    const tool = this.findOpenTool(context.toolCall.id);
    if (!tool) return;
    tool.accepted = true;
    tool.blocked = false;
    tool.execution = 'executed';
    tool.isError = !!context.isError;
    tool.argsChars = boundedInt(JSON.stringify(context.args ?? {}).length);
    tool.resultChars = boundedInt(resultChars);
    if (!tool.isError) {
      const candidate = exposureCandidates(tool.toolName, context.result?.details);
      tool.candidateMessages = candidate.messages;
      tool.candidateMemories = candidate.memories;
    }
  }

  result(provenance: RetrievalProvenance): { modelTurns: ModelTurnAuditEntry[]; toolCalls: ToolAuditEntry[] } {
    if (this.currentTurn) this.closeTurn(null, true);
    const end = this.now();
    const messageFingerprints = new Map(provenance.messageFingerprints.map((v) => [v.messageId, v.fingerprint]));
    const memoryFingerprints = new Map(provenance.memoryFingerprints.map((v) => [v.memoryId, v.fingerprint]));
    const messageIds = new Set(provenance.messageIds);
    const memoryIds = new Set(provenance.memoryIds);
    const toolCalls = this.tools.map((mutable) => {
      if (mutable.endedAtMs === undefined) {
        mutable.endedAtMs = end;
        mutable.durationMs = Math.max(0, end - (mutable.startedAtMs ?? end));
        mutable.reservedChars = Math.max(0, boundedInt(this.charsExposed()) - mutable.beforeChars);
      }
      const messages = mutable.candidateMessages
        .filter((id) => messageIds.has(id) && messageFingerprints.has(id))
        .map((id) => ({ id, fingerprint: messageFingerprints.get(id)! }));
      const memories = mutable.candidateMemories
        .filter((id) => memoryIds.has(id) && memoryFingerprints.has(id))
        .map((id) => ({ id, fingerprint: memoryFingerprints.get(id)! }));
      const candidateCount = mutable.candidateMessages.length + mutable.candidateMemories.length;
      const exposure = messages.length || memories.length
        ? { version: 1 as const, truncatedCount: Math.max(0, candidateCount - messages.length - memories.length), messages, memories }
        : undefined;
      const { beforeChars: _before, candidateMessages: _messages, candidateMemories: _memories, ...entry } = mutable;
      return { ...entry, ...(exposure ? { exposure } : {}) };
    });
    return { modelTurns: [...this.turns], toolCalls };
  }

  private findOpenTool(id: string): MutableTool | undefined {
    return [...this.tools].reverse().find((tool) => tool.toolCallId === id && tool.endedAtMs === undefined);
  }

  private closeTurn(message: unknown, incomplete: boolean): void {
    if (!this.currentTurn) return;
    const endedAtMs = this.now();
    const msg = (message ?? {}) as { role?: string; usage?: Usage; stopReason?: unknown };
    const usage = msg.role === 'assistant' ? msg.usage : undefined;
    const normalizedUsage = normalizeTurnUsage(usage);
    const startedAtMs = this.currentTurn.startedAtMs;
    const modelEndedAtMs = this.currentTurn.modelEndedAtMs;
    this.turns.push({
      version: 2,
      turnIndex: this.turns.length + 1,
      startedAtMs,
      modelEndedAtMs,
      endedAtMs,
      modelDurationMs: modelEndedAtMs === null ? null : Math.max(0, modelEndedAtMs - startedAtMs),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      ...normalizedUsage,
      stopReason: boundedString(msg.stopReason, 40),
      incomplete: incomplete || msg.role !== 'assistant',
    });
    this.currentTurn = null;
  }
}
