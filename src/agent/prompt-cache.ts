import { createHash } from 'node:crypto';
import type { Api, Model } from '@earendil-works/pi-ai';

export type CacheProfile = 'episode' | 'scheduled' | 'direct' | 'recap';

export interface ModelVisibleToolDescriptor {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: unknown;
}

export interface PromptCacheKeyInput {
  profile: CacheProfile;
  model: Pick<Model<Api>, 'provider' | 'api' | 'id'>;
  requestedThinkingLevel: string;
  promptVersion: string;
  stableSystemPrompt: string;
  tools: readonly ModelVisibleToolDescriptor[];
}

function canonicalize(value: unknown, active: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('non-canonical number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new TypeError('non-JSON value');
  if (active.has(value)) throw new TypeError('cyclic value');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError('sparse or decorated array');
      return `[${value.map((entry) => canonicalize(entry, active)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('non-plain object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    // Canonicalize the same enumerable string-key surface JSON sends. Schema
    // libraries may attach symbol metadata that is not model-visible.
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('non-data property');
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(descriptors[key]!.value, active)}`).join(',')}}`;
  } finally {
    active.delete(value);
  }
}

/** Derive a bounded, content-free affinity key, or return undefined on unsafe input. */
export function derivePromptCacheKey(input: PromptCacheKeyInput): string | undefined {
  try {
    const material = canonicalize({
      version: 1,
      profile: input.profile,
      model: {
        provider: input.model.provider,
        api: input.model.api,
        id: input.model.id,
      },
      requestedThinkingLevel: input.requestedThinkingLevel,
      promptVersion: input.promptVersion,
      stableSystemPrompt: input.stableSystemPrompt,
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        constrainedSampling: tool.constrainedSampling ?? null,
      })),
    }, new WeakSet());
    const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 40);
    return `cas:v1:${input.profile}:${digest}`;
  } catch {
    return undefined;
  }
}

/** Replace only the OpenAI Responses body cache key; undefined preserves Pi behavior. */
export function createPromptCacheAffinityHook(key: string | undefined) {
  return (payload: unknown, model: Model<Api>): unknown | undefined => {
    try {
      if (!key || model.api !== 'openai-responses' || payload === null || Array.isArray(payload)) return undefined;
      if (typeof payload !== 'object') return undefined;
      const prototype = Object.getPrototypeOf(payload);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      return { ...payload, prompt_cache_key: key };
    } catch {
      return undefined;
    }
  };
}
