import { describe, expect, it } from 'vitest';
import type { AgentEvent, AfterToolCallContext } from '@earendil-works/pi-agent-core';
import { RunTraceRecorder } from '../../src/agent/run-trace.js';
import type { RetrievalProvenance } from '../../src/agent/run-context.js';

function event(value: object): AgentEvent { return value as AgentEvent; }
const provenance: RetrievalProvenance = {
  channels: [], messageIds: ['m1'], messageFingerprints: [{ messageId: 'm1', fingerprint: 'fp1' }],
  memoryScopes: [], memoryIds: [], memoryFingerprints: [], charsExposed: 12, charBudget: 60_000,
};

describe('RunTraceRecorder', () => {
  it('records turn/model/tool timing without retaining lifecycle payloads', () => {
    let time = 100;
    let chars = 0;
    const trace = new RunTraceRecorder(() => time += 10, () => chars);
    trace.event(event({ type: 'turn_start' }));
    trace.event(event({ type: 'message_end', message: { role: 'assistant', content: 'SECRET_ASSISTANT' } }));
    trace.event(event({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'search_messages', args: { query: 'SECRET_QUERY' } }));
    trace.before('call-1', 24);
    chars = 12;
    trace.after({
      toolCall: { id: 'call-1', name: 'search_messages' }, args: { query: 'SECRET_QUERY' },
      result: { content: [{ type: 'text', text: 'SECRET_RESULT' }], details: { resultIds: ['m1', 'attempted-hidden'], arbitrary: 'SECRET_DETAILS' } },
      isError: false,
    } as unknown as AfterToolCallContext, 13);
    trace.event(event({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'search_messages', result: 'SECRET_RESULT', isError: false }));
    trace.event(event({ type: 'turn_end', message: { role: 'assistant', usage: {
      input: 5, cacheRead: 2, cacheWrite: 1, cacheWrite1h: 1, output: 3,
      reasoning: 2, totalTokens: 11,
      cost: { input: 0.003, output: 0.004, cacheRead: 0.001, cacheWrite: 0.002, total: 0.01 },
    }, stopReason: 'toolUse' }, toolResults: [] }));
    const result = trace.result(provenance);
    expect(result.modelTurns[0]).toMatchObject({
      version: 2, turnIndex: 1, modelDurationMs: 10, inputTokens: 8, outputTokens: 3,
      uncachedInputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1,
      cacheWrite1hTokens: 1, reasoningTokens: 2, providerTotalTokens: 11,
      uncachedInputCostUsd: 0.003, outputCostUsd: 0.004,
      cacheReadCostUsd: 0.001, cacheWriteCostUsd: 0.002, incomplete: false,
    });
    expect(result.toolCalls[0]).toMatchObject({ turnIndex: 1, sequence: 1, durationMs: 10, reservedChars: 12, execution: 'executed' });
    expect(result.toolCalls[0]?.exposure?.messages).toEqual([{ id: 'm1', fingerprint: 'fp1' }]);
    const json = JSON.stringify(result);
    for (const secret of ['SECRET_ASSISTANT', 'SECRET_QUERY', 'SECRET_RESULT', 'SECRET_DETAILS', 'attempted-hidden']) expect(json).not.toContain(secret);
    expect(json).not.toContain('parent');
  });

  it('closes open spans as incomplete and tolerates a decreasing clock', () => {
    const times = [100, 90, 80, 70];
    const trace = new RunTraceRecorder(() => times.shift() ?? 60, () => 0);
    trace.event(event({ type: 'turn_start' }));
    trace.event(event({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'unknown', args: {} }));
    const result = trace.result({ ...provenance, messageIds: [], messageFingerprints: [], charsExposed: 0 });
    expect(result.modelTurns[0]?.incomplete).toBe(true);
    expect(result.modelTurns[0]?.durationMs).toBe(0);
    expect(result.toolCalls[0]?.durationMs).toBe(0);
    expect(result.toolCalls[0]?.execution).toBe('not_executed');
  });
});
