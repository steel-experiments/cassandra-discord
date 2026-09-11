import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import {
  createMcpServer,
  MCP_JSONRPC_ERROR,
  type McpAuditRecord,
  type McpAuditSink,
} from '../../src/mcp/server.js';
import { MCP_TOOLS } from '../../src/mcp/tools.js';
import { createMcpToken } from '../../src/mcp/auth.js';
import { createRateLimiter } from '../../src/mcp/rate-limit.js';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';

/**
 * Privacy-safe MCP request auditing (Section 32.5.4; task T105).
 *
 * Acceptance — verbatim: "Every request is logged with token ID, tool name,
 * result count, and duration. Content is never logged."
 *
 * The suite injects an audit sink that captures the record written for each
 * request, then drives every status path over the real HTTP server: a
 * successful built-in (`tools/list`) reports its tool count; the credential,
 * rate-limit, malformed-body, malformed-envelope, unknown-method,
 * unknown-tool, bad-params, and protocol-version paths each map to their coarse
 * status. A final pair of canary checks proves the records — and the default
 * logger line — carry neither the bearer plaintext, the request body, nor the
 * URL query string.
 */

const GUILD = '100000000000000001';
const ACTOR = '100000000000000003';
const HOST = '127.0.0.1';
const PATH = '/mcp';

let env: TestDb;
const servers: HttpServerHandle[] = [];
let records: McpAuditRecord[];

beforeEach(() => {
  env = createTestDb();
  seedIdentity(env.db, GUILD);
  records = [];
});

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  env.cleanup();
});

function issueToken(): string {
  const o = createMcpToken({ db: env.db, nowMs: Date.now() }, { name: 't', createdByUserId: ACTOR });
  if (o.kind !== 'created') throw new Error('token not created');
  return o.token;
}

interface StartOpts {
  limiter?: ReturnType<typeof createRateLimiter>;
  audit?: McpAuditSink;
  loggerStream?: Writable;
}

async function start(opts: StartOpts = {}): Promise<{ base: string; token: string }> {
  const logger = opts.loggerStream ? createLogger({ stream: opts.loggerStream, name: 'mcp-audit-test', level: 'info' }) : undefined;
  const mcp = createMcpServer({
    db: env.db,
    rateLimiter: opts.limiter ?? createRateLimiter({ limit: 60 }),
    audit: opts.audit ?? (opts.loggerStream ? undefined : sink),
    logger,
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
  return { base: `http://${HOST}:${handle.port}`, token: issueToken() };
}

/** Default injected sink for the metadata tests: capture every record. */
const sink: McpAuditSink = (rec) => {
  records.push(rec);
};

function rpc(method: string, params: unknown, id: unknown = '1'): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

async function post(
  base: string,
  body: string,
  headers: Record<string, string> = {},
  path: string = PATH,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('one audit record per request with required metadata', () => {
  it('records exactly one entry for a successful tools/list, with the tool count', async () => {
    const { base, token } = await start();
    const res = await post(base, rpc('tools/list', {}), { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec).toMatchObject({
      event: 'mcp.request',
      authOutcome: 'authenticated',
      method: 'tools/list',
      status: 'ok',
    });
    // The handler reports the catalog size via auditCount; this is the threading
    // proof — a handler that omitted auditCount would record 0 here.
    expect(rec.resultCount).toBe(MCP_TOOLS.length);
    expect(rec.toolName).toBeNull();
    expect(rec.tokenId).not.toBe(token); // tokenId is the row id, never the plaintext.
    expect(typeof rec.tokenId).toBe('string');
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records resultCount 0 when a method omits auditCount', async () => {
    const { base, token } = await start();
    // server/discover reports auditCount 1; a method with no auditCount defaults to 0.
    await post(base, rpc('server/discover', {}), { authorization: `Bearer ${token}` });
    expect(records.at(-1)?.resultCount).toBe(1);
    // Drive a tools/call that returns INVALID_PARAMS before any result — count stays 0.
    await post(
      base,
      rpc('tools/call', { name: 'search_messages', arguments: 'not-an-object' }),
      { authorization: `Bearer ${token}` },
    );
    const rec = records.at(-1)!;
    expect(rec.resultCount).toBe(0);
    expect(rec.toolName).toBe('search_messages');
  });
});

describe('each exit path maps to a coarse status', () => {
  it('records unauthenticated (no bearer) with null tokenId and method', async () => {
    const { base } = await start();
    const res = await post(base, rpc('tools/list', {}));
    expect(res.status).toBe(401);
    const rec = records[0]!;
    expect(rec).toMatchObject({
      authOutcome: 'unauthenticated',
      status: 'unauthenticated',
      tokenId: null,
      method: null,
      toolName: null,
    });
  });

  it('records rate_limited with the resolved tokenId', async () => {
    const { base, token } = await start({ limiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });
    await post(base, rpc('tools/list', {}), { authorization: `Bearer ${token}` });
    expect(records.at(-1)!.status).toBe('ok');
    await post(base, rpc('tools/list', {}), { authorization: `Bearer ${token}` });
    const rec = records.at(-1)!;
    expect(rec.authOutcome).toBe('rate_limited');
    expect(rec.status).toBe('rate_limited');
    expect(typeof rec.tokenId).toBe('string');
  });

  it('records malformed for an unreadable JSON body', async () => {
    const { base, token } = await start();
    await post(base, '{not json', { authorization: `Bearer ${token}` });
    const rec = records[0]!;
    expect(rec.status).toBe('malformed');
    expect(rec.method).toBeNull();
  });

  it('records malformed for an invalid JSON-RPC envelope', async () => {
    const { base, token } = await start();
    await post(base, JSON.stringify({ jsonrpc: '1.0', method: 'tools/list', id: '1' }), {
      authorization: `Bearer ${token}`,
    });
    expect(records.at(-1)!.status).toBe('malformed');
  });

  it('records unknown_method for an unregistered method', async () => {
    const { base, token } = await start();
    await post(base, rpc('does/not/exist', {}), { authorization: `Bearer ${token}` });
    const rec = records.at(-1)!;
    expect(rec.status).toBe('unknown_method');
    expect(rec.method).toBe('does/not/exist');
    expect(rec.toolName).toBeNull();
  });

  it('records unknown_tool for a tools/call with an unknown tool name', async () => {
    const { base, token } = await start();
    await post(base, rpc('tools/call', { name: 'not_a_real_tool' }), { authorization: `Bearer ${token}` });
    const rec = records.at(-1)!;
    expect(rec.status).toBe('unknown_tool');
    expect(rec.method).toBe('tools/call');
    expect(rec.toolName).toBe('not_a_real_tool');
    expect(rec.resultCount).toBe(0);
  });

  it('records bad_params for a tools/call whose arguments fail validation', async () => {
    const { base, token } = await start();
    const res = await post(
      base,
      rpc('tools/call', { name: 'search_messages', arguments: 'not-an-object' }),
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
      MCP_JSONRPC_ERROR.INVALID_PARAMS,
    );
    const rec = records.at(-1)!;
    expect(rec.status).toBe('bad_params');
    expect(rec.toolName).toBe('search_messages');
  });

  it('records protocol for an unsupported protocol version', async () => {
    const { base, token } = await start();
    await post(base, rpc('tools/list', {}), {
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': '1999-01-01',
    });
    expect(records.at(-1)!.status).toBe('protocol');
  });
});

describe('content and credentials never reach the audit record', () => {
  it('omits the bearer plaintext, body canary, and query string from captured records', async () => {
    const { base, token } = await start();
    const bodyCanary = 'SECRET-CONTENT-XYZ';
    const queryCanary = 'LEAKED-QUERY-VALUE';
    // A body carrying an extra canary field (ignored by the envelope parser) and
    // a query string on the URL — neither must survive into the record.
    await post(
      base,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: '1', canary: bodyCanary }),
      { authorization: `Bearer ${token}` },
      `${PATH}?q=${queryCanary}`,
    );
    const dump = JSON.stringify(records);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(bodyCanary);
    expect(dump).not.toContain(queryCanary);
    // And the metadata that SHOULD be present still is.
    expect(dump).toContain('"mcp.request"');
  });
});

describe('the default logger sink emits only privacy-safe fields', () => {
  it('writes a structured line without the bearer plaintext or body content', async () => {
    const parts: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        parts.push(typeof chunk === 'string' ? chunk : chunk.toString());
        cb();
      },
    });
    const { base, token } = await start({ loggerStream: stream });
    const bodyCanary = 'SECRET-CONTENT-XYZ';
    await post(
      base,
      JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id: '1', canary: bodyCanary }),
      { authorization: `Bearer ${token}` },
    );
    const line = parts.join('');
    expect(line).toContain('"event":"mcp.request"');
    expect(line).toContain('"mcpStatus":"ok"');
    expect(line).toContain('"mcpMethod":"tools/list"');
    expect(line).not.toContain(token);
    expect(line).not.toContain(bodyCanary);
  });
});
