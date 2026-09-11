import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TextContent } from '@earendil-works/pi-ai';
import { type Static } from '@sinclair/typebox';
import { SearchMemoriesToolInput } from '../schemas.js';
import {
  searchMemories,
  type MemorySearchResult,
} from '../../memory/search.js';
import { fitItemsToBudget, type AgentRunContext } from '../run-context.js';

/**
 * `search_memories` — FTS over memories whose current scope the run can see
 * (Sections 7.3, 22.3). Scope is recomputed at read time by the repository, so a
 * memory whose evidence has been reclassified to a hidden channel never appears.
 * Exposed memory scopes (and, for channel-scoped memories, the channel) are
 * recorded as provenance; results are bounded by the per-run character budget.
 */
export interface SearchMemoriesDetails {
  resultIds: string[];
  truncated: number;
  charsExposed: number;
}

const DESCRIPTION = `Search organizational memory statements visible to this run by topic.
Every term in an ordinary query is ANDed, so use one concise canonical term or tight phrase
and put synonyms in separate calls. For a broad inventory, use list_memories instead. The
exact query "*" remains a compatibility alias for list_memories. Returns id, type, status,
confidence, importance, scope, and statement.`;

function renderMemory(r: MemorySearchResult): string {
  const scope =
    r.scopeType === 'channel'
      ? `channel:${r.scopeKey ?? '?'}`
      : r.scopeType === 'review_only'
        ? 'review_only'
        : 'org';
  return [
    `[${r.memoryId}] ${r.type} (${r.status}, confidence ${r.confidence.toFixed(2)}, importance ${r.importance.toFixed(2)}, scope ${scope})`,
    r.statement,
  ].join('\n');
}

export function createSearchMemoriesTool(
  ctx: AgentRunContext,
): AgentTool<typeof SearchMemoriesToolInput, SearchMemoriesDetails> {
  return {
    name: 'search_memories',
    label: 'Search memories',
    description: DESCRIPTION,
    parameters: SearchMemoriesToolInput,
    async execute(_toolCallId, params: Static<typeof SearchMemoriesToolInput>): Promise<
      AgentToolResult<SearchMemoriesDetails>
    > {
      const results = searchMemories(ctx.db, ctx.grant, {
        query: params.query,
        types: params.types,
        statuses: params.statuses,
        limit: params.limit,
        now: ctx.retrieval.nowMs,
      });

      const fit = fitItemsToBudget(
        ctx.retrieval,
        results,
        renderMemory,
        (n) => `[${n} more memory(s) omitted — per-run character budget reached]`,
      );
      for (const r of fit.included) {
        ctx.retrieval.recordMemory(r.memoryId);
        ctx.retrieval.recordMemoryScope(r.scopeType, r.scopeKey, 'memory_search');
        if (r.scopeType === 'channel' && r.scopeKey) {
          ctx.retrieval.recordChannel(r.scopeKey, 'memory_search');
        }
      }

      const header =
        fit.included.length > 0 ? `${fit.included.length} memory(ies):` : 'No permitted memories matched.';
      const text = `${header}\n${fit.lines.join('\n')}`;

      return {
        content: [{ type: 'text', text } as TextContent],
        details: {
          resultIds: fit.included.map((r) => r.memoryId),
          truncated: fit.truncated,
          charsExposed: ctx.retrieval.charsExposed,
        },
      };
    },
  };
}
