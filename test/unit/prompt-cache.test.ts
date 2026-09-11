import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createPromptCacheAffinityHook,
  derivePromptCacheKey,
  type PromptCacheKeyInput,
} from '../../src/agent/prompt-cache.js';

const model = {
  provider: 'openai', api: 'openai-responses', id: 'gpt-5.6-terra',
} as Model<Api>;

function input(over: Partial<PromptCacheKeyInput> = {}): PromptCacheKeyInput {
  return {
    profile: 'episode',
    model,
    requestedThinkingLevel: 'medium',
    promptVersion: 'prompt-v1',
    stableSystemPrompt: 'stable system bytes',
    tools: [{
      name: 'search_messages',
      description: 'Search permitted messages.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
      constrainedSampling: { type: 'json_schema', strict: 'require' },
    }],
    ...over,
  };
}

describe('prompt cache affinity key', () => {
  it('is deterministic, versioned, bounded, and content-free', () => {
    const first = derivePromptCacheKey(input());
    expect(first).toBe(derivePromptCacheKey(input()));
    expect(first).toMatch(/^cas:v1:episode:[0-9a-f]{40}$/);
    expect(first!.length).toBeLessThanOrEqual(64);
    for (const sentinel of ['guild-secret', 'session-secret', 'Discord secret text']) {
      expect(first).not.toContain(sentinel);
    }
  });

  it.each([
    ['profile', { profile: 'direct' as const }],
    ['provider', { model: { ...model, provider: 'azure' } as Model<Api> }],
    ['api', { model: { ...model, api: 'openai-completions' } as Model<Api> }],
    ['model', { model: { ...model, id: 'gpt-other' } as Model<Api> }],
    ['thinking', { requestedThinkingLevel: 'high' }],
    ['prompt version', { promptVersion: 'prompt-v2' }],
    ['system bytes', { stableSystemPrompt: 'stable system bytes changed' }],
    ['tool name', { tools: [{ ...input().tools[0]!, name: 'list_messages' }] }],
    ['tool description', { tools: [{ ...input().tools[0]!, description: 'Different.' }] }],
    ['tool schema', { tools: [{ ...input().tools[0]!, parameters: { type: 'string' } }] }],
    ['sampling', { tools: [{ ...input().tools[0]!, constrainedSampling: false }] }],
  ] satisfies Array<[string, Partial<PromptCacheKeyInput>]>)('rotates for %s', (_name, over) => {
    expect(derivePromptCacheKey(input(over))).not.toBe(derivePromptCacheKey(input()));
  });

  it('canonicalizes object keys but preserves array and tool order', () => {
    const a = input({ tools: [
      { name: 'a', description: 'A', parameters: { b: 2, a: { y: 2, x: 1 } } },
      { name: 'b', description: 'B', parameters: { enum: ['x', 'y'] } },
    ] });
    const reorderedObjects = input({ tools: [
      { name: 'a', description: 'A', parameters: { a: { x: 1, y: 2 }, b: 2 } },
      { name: 'b', description: 'B', parameters: { enum: ['x', 'y'] } },
    ] });
    expect(derivePromptCacheKey(a)).toBe(derivePromptCacheKey(reorderedObjects));
    expect(derivePromptCacheKey(input({ tools: [...a.tools].reverse() }))).not.toBe(derivePromptCacheKey(a));
    expect(derivePromptCacheKey(input({ tools: [a.tools[0]!, { ...a.tools[1]!, parameters: { enum: ['y', 'x'] } }] })))
      .not.toBe(derivePromptCacheKey(a));
  });

  it('keeps profiles separate and has no task/session/runtime input surface', () => {
    const episode = derivePromptCacheKey(input({ profile: 'episode' }));
    expect(derivePromptCacheKey(input({ profile: 'recap' }))).not.toBe(episode);
    expect(Object.keys(input())).toEqual([
      'profile', 'model', 'requestedThinkingLevel', 'promptVersion', 'stableSystemPrompt', 'tools',
    ]);
  });

  it('falls back for cyclic, non-JSON, non-finite, sparse, and boundary-malformed schemas', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 'gap';
    for (const parameters of [cyclic, { value: () => true }, { value: Infinity }, new Date(), sparse]) {
      expect(derivePromptCacheKey(input({ tools: [{ name: 'x', description: 'x', parameters }] }))).toBeUndefined();
    }
    expect(derivePromptCacheKey(input({ stableSystemPrompt: 'ab', promptVersion: 'c' })))
      .not.toBe(derivePromptCacheKey(input({ stableSystemPrompt: 'a', promptVersion: 'bc' })));
  });
});

describe('OpenAI Responses payload hook', () => {
  it('shallow-copies a plain body and replaces only prompt_cache_key', () => {
    const payload = { input: ['safe'], prompt_cache_key: 'pi-session', store: false };
    const result = createPromptCacheAffinityHook('cas:v1:episode:abc')(payload, model);
    expect(result).toEqual({ ...payload, prompt_cache_key: 'cas:v1:episode:abc' });
    expect(result).not.toBe(payload);
    expect(payload.prompt_cache_key).toBe('pi-session');
  });

  it('leaves unsupported APIs, malformed payloads, and missing keys unchanged', () => {
    const unsupported = { ...model, api: 'openai-completions' } as Model<Api>;
    const hook = createPromptCacheAffinityHook('key');
    expect(hook({ input: [] }, unsupported)).toBeUndefined();
    expect(hook([], model)).toBeUndefined();
    expect(hook(null, model)).toBeUndefined();
    expect(createPromptCacheAffinityHook(undefined)({ input: [] }, model)).toBeUndefined();
  });
});
