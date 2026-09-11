import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { parseDailyBudget } from '../config.js';
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type MutableModels,
  type ThinkingLevel,
} from '@earendil-works/pi-ai';

/**
 * Startup model resolution and tool-calling validation (Sections 4.1, 21.3, 35.4).
 *
 * Nothing about the model is hard-coded: the provider, primary model, optional
 * triage model, base URL, budget, and reasoning effort all come from
 * configuration. Before the agent is allowed to become ready we resolve each
 * configured model through pi-ai's catalog and reject any model that cannot
 * make tool calls — the agent's only capabilities are its purpose-built tools
 * (Section 4.1), so a tool-less model is unusable and must fail fast with a
 * message that names what is wrong.
 *
 * Resolution is split into small, side-effect-free pieces so each can be tested
 * without network access: pi-ai's built-in catalog is a static read, so
 * {@link resolveAgentModels} never reaches the network.
 */

/** pi-ai chat APIs that carry function-tool support. A model whose `api` is not
 *  in this set cannot run the agent loop and is rejected at startup. */
export const TOOL_CAPABLE_APIS: readonly Api[] = [
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'openai-completions',
  'anthropic-messages',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'mistral-conversations',
  'pi-messages',
];
const TOOL_CAPABLE_SET = new Set<string>(TOOL_CAPABLE_APIS);

/** Valid reasoning-effort levels (Section 35.4 `AGENT_THINKING_LEVEL`). */
export const THINKING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/**
 * Maps a provider id to the credential environment variable its key lives in
 * (Section 35.1). Only the selected provider's key is required; unknown
 * providers fall back to a generic `LLM_API_KEY` and are not enforced here —
 * their auth is checked downstream by pi-ai's credential resolution.
 */
const PROVIDER_CREDENTIAL_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
};
const GENERIC_CREDENTIAL_ENV = 'LLM_API_KEY';

/** Thrown when configuration cannot produce a usable, tool-capable model. */
export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

export interface AgentModelConfig {
  providerId: string;
  primaryModelId: string;
  triageModelId: string | null;
  baseUrl: string | null;
  dailyBudgetUsd: number | null;
  thinkingLevel: ThinkingLevel;
}

export interface ResolvedModel {
  /** The resolved pi-ai model (baseUrl overridden when configured). */
  model: Model<Api>;
  /** The base URL actually in effect after applying `LLM_BASE_URL`. */
  effectiveBaseUrl: string;
  /** Reasoning effort clamped to what this model supports (`off` for non-reasoning models). */
  thinkingLevel: ModelThinkingLevel;
}

export interface ResolvedAgentModels {
  providerId: string;
  primary: ResolvedModel;
  triage: ResolvedModel | null;
  dailyBudgetUsd: number | null;
  thinkingLevel: ThinkingLevel;
}

/**
 * Read the model configuration block from `env`. Pure: no catalog, no network.
 * Throws {@link ModelConfigError} with a specific message when a required value
 * is missing, the thinking level is unknown, or the budget is not a number.
 */
export function readModelConfig(env: Record<string, string | undefined>): AgentModelConfig {
  const providerId = env.LLM_PROVIDER?.trim();
  if (!providerId) {
    throw new ModelConfigError('LLM_PROVIDER is required but was not set.');
  }

  const primaryModelId = env.LLM_MODEL?.trim();
  if (!primaryModelId) {
    throw new ModelConfigError('LLM_MODEL is required but was not set.');
  }

  const triageRaw = env.TRIAGE_LLM_MODEL?.trim();
  const triageModelId = triageRaw ? triageRaw : null;

  const baseUrl = env.LLM_BASE_URL?.trim() || null;

  const thinkingRaw = (env.AGENT_THINKING_LEVEL?.trim() || DEFAULT_THINKING_LEVEL) as ThinkingLevel;
  if (!THINKING_LEVEL_SET.has(thinkingRaw)) {
    throw new ModelConfigError(
      `AGENT_THINKING_LEVEL "${thinkingRaw}" is not one of: ${THINKING_LEVELS.join(', ')}.`,
    );
  }

  // One parser for the daily budget, shared with the application config, so
  // both entry points read the same default, the `unlimited` keyword, and the
  // same rejection of non-numeric values.
  let dailyBudgetUsd: number | null;
  try {
    dailyBudgetUsd = parseDailyBudget(env.LLM_DAILY_BUDGET_USD);
  } catch (err) {
    throw new ModelConfigError((err as Error).message);
  }

  return {
    providerId,
    primaryModelId,
    triageModelId,
    baseUrl,
    dailyBudgetUsd,
    thinkingLevel: thinkingRaw,
  };
}

export interface ResolvedCredential {
  /** The environment variable the provider's key is expected in. */
  envVar: string;
  /** The credential value, or undefined when not present. */
  value: string | undefined;
  /** Whether absence is a hard startup error for this provider. */
  required: boolean;
}

/**
 * Resolve the selected provider's credential variable (Section 21.3). For the
 * providers in {@link PROVIDER_CREDENTIAL_ENV} the key is required and a missing
 * value throws; for any other provider the generic fallback is returned without
 * enforcement so custom/ambient auth is not blocked here.
 */
export function resolveCredential(
  env: Record<string, string | undefined>,
  providerId: string,
): ResolvedCredential {
  const envVar = PROVIDER_CREDENTIAL_ENV[providerId] ?? GENERIC_CREDENTIAL_ENV;
  const value = env[envVar]?.trim() || undefined;
  const required = providerId in PROVIDER_CREDENTIAL_ENV;
  if (required && !value) {
    throw new ModelConfigError(
      `Provider "${providerId}" requires ${envVar}, but it was not set.`,
    );
  }
  return { envVar, value, required };
}

/** Whether a model speaks a tool-capable pi-ai API. */
export function supportsToolCalling(model: Model<Api>): boolean {
  return TOOL_CAPABLE_SET.has(model.api);
}

/** Whether the catalog carries at least one positive token rate for this model. */
export function hasBillablePricing(model: Model<Api>): boolean {
  const rates = [
    model.cost.input,
    model.cost.output,
    model.cost.cacheRead,
    model.cost.cacheWrite,
    ...(model.cost.tiers ?? []).flatMap((tier) => [
      tier.input,
      tier.output,
      tier.cacheRead,
      tier.cacheWrite,
    ]),
  ];
  return rates.some((rate) => Number.isFinite(rate) && rate > 0);
}

/** Sync model lookup against a pi-ai catalog. */
export type ModelLookup = (providerId: string, modelId: string) => Model<Api> | undefined;

/** Build a {@link ModelLookup} over a `Models` collection. */
export function defaultModelLookup(models: Models): ModelLookup {
  return (providerId, modelId) => models.getModel(providerId, modelId);
}

function applyBaseUrl(model: Model<Api>, baseUrl: string | null): Model<Api> {
  if (!baseUrl || baseUrl === model.baseUrl) return model;
  // The catalog model is treated as immutable; carry the override forward.
  return { ...model, baseUrl };
}

function resolveOne(
  config: AgentModelConfig,
  lookup: ModelLookup,
  modelId: string,
): ResolvedModel {
  const found = lookup(config.providerId, modelId);
  if (!found) {
    throw new ModelConfigError(
      `Model "${modelId}" was not found for provider "${config.providerId}".`,
    );
  }
  const model = applyBaseUrl(found, config.baseUrl);
  if (!supportsToolCalling(model)) {
    throw new ModelConfigError(
      `Model "${modelId}" (api "${found.api}") does not support tool calling; ` +
        'the agent requires tool calling for its purpose-built tools.',
    );
  }
  const thinkingLevel = clampThinkingLevel(model, config.thinkingLevel);
  return { model, effectiveBaseUrl: model.baseUrl, thinkingLevel };
}

/**
 * Resolve the primary and optional triage models through `lookup` and validate
 * that each supports tool calling. Pure given the lookup: the default lookup
 * reads pi-ai's static built-in catalog, so no network access is needed.
 */
export function resolveAgentModels(
  config: AgentModelConfig,
  lookup: ModelLookup,
): ResolvedAgentModels {
  const primary = resolveOne(config, lookup, config.primaryModelId);
  const triage = config.triageModelId
    ? resolveOne(config, lookup, config.triageModelId)
    : null;
  return {
    providerId: config.providerId,
    primary,
    triage,
    dailyBudgetUsd: config.dailyBudgetUsd,
    thinkingLevel: config.thinkingLevel,
  };
}

export interface ConfigureAgentModelsOptions {
  env: Record<string, string | undefined>;
  /** Inject a catalog; defaults to every pi-ai built-in provider. */
  models?: MutableModels;
}

/**
 * Production entry point: read configuration, enforce the provider credential,
 * resolve the models against the built-in catalog, and validate tool calling.
 * Throws {@link ModelConfigError} for any unrecoverable misconfiguration.
 */
export function configureAgentModels(options: ConfigureAgentModelsOptions): ResolvedAgentModels {
  const config = readModelConfig(options.env);
  resolveCredential(options.env, config.providerId);
  const models = options.models ?? builtinModels();
  return resolveAgentModels(config, defaultModelLookup(models));
}
