import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import {
  createMcpServer,
  MCP_DEFAULT_INITIALIZE_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSION,
} from '../../src/mcp/server.js';
import {
  MCP_CACHE_SCOPE,
  MCP_TOOL_LIST_TTL_MS,
  MCP_SERVER_NAME,
  MCP_TOOL_NAMES,
} from '../../src/mcp/tools.js';
import { createMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { APP_VERSION } from '../../src/version.js';

/**
 * MCP discovery and cached tool listing (Sections 32.5.1, 32.5.3; task T102).
 *
 * Acceptance — verbatim: "Clients can enumerate exactly the supported read-only
 * tools without an initialize handshake."
 *
 * The suite mounts the MCP server (with no injected methods — discover and
 * tools/list are built in) and drives `server/discover` and `tools/list` as the
 * very first requests, proving the stateless model needs no `initialize`. It
 * checks the eight read-only tools, the capability envelope (tools only; no roots,
 * sampling, or logging), the server identity, and the 300000 ms `ttlMs` cache hint.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const HOST = '127.0.0.1';
const PATH = '/mcp';

let env: TestDb;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

async function start(toolListTtlMs?: number): Promise<{ base: string; token: string }> {
  const mcp = createMcpServer({
    db: env.db,
    rateLimiter: createRateLimiter({ limit: 60 }),
    toolListTtlMs,
  });
  const handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    mcpPath: PATH,
    mcpEnabled: true,
    mcpHandler: mcp.handler,
  });
  servers.push(handle);
  const issued = createMcpToken({ db: env.db, nowMs: Date.now() }, { name: 't', createdByUserId: ACTOR });
  if (issued.kind !== 'created') throw new Error('token not created');
  return { base: `http://${HOST}:${handle.port}`, token: issued.token };
}

async function call(base: string, token: string, method: string, params: unknown = {}, id = '1'): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': SUPPORTED_MCP_PROTOCOL_VERSION,
      'mcp-method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: {
        ...(typeof params === 'object' && params !== null ? params : {}),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': SUPPORTED_MCP_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'compatibility-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('server/discover (no initialize handshake)', () => {
  it('answers the very first request with capabilities and server identity', async () => {
    const { base, token } = await start();
    const { status, body } = await call(base, token, 'server/discover');
    expect(status).toBe(200);
    const result = body.result as Record<string, unknown>;
    expect(result.resultType).toBe('complete');
    expect(result.supportedVersions).toEqual([SUPPORTED_MCP_PROTOCOL_VERSION]);
    expect(result._meta).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: APP_VERSION },
    });
    expect(result.ttlMs).toBe(MCP_TOOL_LIST_TTL_MS);
    expect(result.cacheScope).toBe(MCP_CACHE_SCOPE);
    expect(typeof result.instructions).toBe('string');
    expect((result.instructions as string).length).toBeGreaterThan(0);
  });

  it('advertises tools capability only — no roots, sampling, or logging', async () => {
    const { base, token } = await start();
    const { body } = await call(base, token, 'server/discover');
    const result = body.result as Record<string, unknown>;
    const capabilities = result.capabilities as Record<string, unknown>;
    expect(capabilities.tools).toBeDefined();
    expect(capabilities.roots).toBeUndefined();
    expect(capabilities.sampling).toBeUndefined();
    expect(capabilities.logging).toBeUndefined();
  });

  it('still requires authentication (401 without a token)', async () => {
    const { base } = await start();
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'server/discover', id: '1' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('legacy initialize compatibility', () => {
  it('negotiates a supported initialize-capable version and identifies the server', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'compatibility-test', version: '1.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: Record<string, unknown> };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo).toEqual({ name: MCP_SERVER_NAME, version: APP_VERSION });
  });

  it('selects the latest initialize-capable version for an unknown request', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe(MCP_DEFAULT_INITIALIZE_PROTOCOL_VERSION);
  });

  it('accepts initialized notifications and legacy-version tool requests', async () => {
    const { base, token } = await start();
    const notification = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);

    const listed = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { result: { tools: unknown[] } };
    expect(body.result.tools).toHaveLength(8);
  });
});

describe('tools/list enumerates exactly the eight read-only tools', () => {
  it('returns the eight tools with ttlMs cache hint', async () => {
    const { base, token } = await start();
    const { status, body } = await call(base, token, 'tools/list');
    expect(status).toBe(200);
    const result = body.result as {
      resultType: string;
      tools: Array<{ name: string; inputSchema: unknown }>;
      ttlMs: number;
      cacheScope: string;
    };
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(MCP_TOOL_LIST_TTL_MS);
    expect(result.cacheScope).toBe(MCP_CACHE_SCOPE);
    expect(result.tools).toHaveLength(8);
    expect(result.tools.map((t) => t.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES).toEqual([
      'search_messages',
      'list_recent_messages',
      'get_message_context',
      'search_memories',
      'list_memories',
      'get_memory',
      'get_memory_evidence',
      'list_channels',
    ]);
  });

  it('describes required params per tool without leaking internal policy', async () => {
    const { base, token } = await start();
    const { body } = await call(base, token, 'tools/list');
    const tools = (body.result as { tools: Array<Record<string, unknown>> }).tools;
    const byName = new Map(tools.map((t) => [t.name as string, t]));

    type ScalarSchema = {
      minLength?: number;
      maxLength?: number;
      minimum?: number;
      maximum?: number;
      type?: string;
    };
    type ArraySchema = {
      maxItems?: number;
      items?: { anyOf?: Array<{ const?: string }> };
    };
    type ObjectInputSchema = {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, ScalarSchema | ArraySchema>;
    };
    const schemaFor = (name: string): ObjectInputSchema => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`tools/list omitted required tool: ${name}`);
      return tool.inputSchema as ObjectInputSchema;
    };
    const enumValues = (schema: ArraySchema): string[] =>
      (schema.items?.anyOf ?? []).flatMap((item) =>
        typeof item.const === 'string' ? [item.const] : [],
      );

    const searchMessages = schemaFor('search_messages');
    expect(searchMessages.required).toEqual(['query']);

    const listRecentMessages = schemaFor('list_recent_messages');
    expect(listRecentMessages.required).toEqual([]);
    expect(listRecentMessages.additionalProperties).toBe(false);
    expect(Object.keys(listRecentMessages.properties).sort()).toEqual([
      'after',
      'authorIds',
      'before',
      'beforeMessageId',
      'channelIds',
      'limit',
    ]);
    expect(listRecentMessages.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    });

    const getContext = schemaFor('get_message_context');
    expect(getContext.required).toEqual(['messageId']);
    expect(getContext.additionalProperties).toBe(false);
    expect(Object.keys(getContext.properties).sort()).toEqual([
      'afterCount',
      'beforeCount',
      'includeReplies',
      'messageId',
    ]);
    expect(getContext.properties.messageId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 64,
    });
    for (const field of ['beforeCount', 'afterCount']) {
      expect(getContext.properties[field]).toMatchObject({
        type: 'integer',
        minimum: 0,
        maximum: 50,
      });
    }
    expect(getContext.properties.includeReplies).toMatchObject({ type: 'boolean' });

    const searchMemories = schemaFor('search_memories');
    expect(searchMemories.required).toEqual(['query']);
    expect(searchMemories.additionalProperties).toBe(false);
    expect(searchMemories.properties.query).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 256,
    });

    const listMemories = schemaFor('list_memories');
    expect(listMemories.required).toEqual([]);
    expect(listMemories.additionalProperties).toBe(false);
    expect(Object.keys(listMemories.properties).sort()).toEqual(['limit', 'statuses', 'types']);

    for (const schema of [searchMemories, listMemories]) {
      expect(schema.properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
      expect(schema.properties.types).toMatchObject({ type: 'array', maxItems: 10 });
      expect(schema.properties.statuses).toMatchObject({ type: 'array', maxItems: 5 });
      expect(enumValues(schema.properties.types as ArraySchema)).toEqual([
        'decision',
        'assumption',
        'prediction',
        'fact',
        'risk',
        'commitment',
        'experiment',
        'disagreement',
        'constraint',
        'open_question',
      ]);
      expect(enumValues(schema.properties.statuses as ArraySchema)).toEqual([
        'active',
        'superseded',
        'resolved',
        'invalidated',
        'expired',
      ]);
    }

    expect(schemaFor('get_memory').required).toEqual(['memoryId']);

    const getMemoryEvidence = schemaFor('get_memory_evidence');
    expect(getMemoryEvidence.required).toEqual(['memoryId']);
    expect(getMemoryEvidence.additionalProperties).toBe(false);
    expect(Object.keys(getMemoryEvidence.properties).sort()).toEqual(['limit', 'memoryId']);
    expect(getMemoryEvidence.properties.memoryId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 64,
    });
    expect(getMemoryEvidence.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 50,
    });

    expect(schemaFor('list_channels').required).toEqual([]);

    // No tool description leaks internal scoring/policy vocabulary.
    const blob = JSON.stringify(tools);
    for (const term of ['computed_score', 'threshold', 'prompt', 'apiKey', 'token_hash']) {
      expect(blob).not.toContain(term);
    }
  });

  it('honors a configured ttlMs override', async () => {
    const { base, token } = await start(60_000);
    const { body } = await call(base, token, 'tools/list');
    expect((body.result as { ttlMs: number }).ttlMs).toBe(60_000);
  });
});
