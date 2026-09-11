import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect } from 'node:net';
import { createLogger } from '../../src/logger.js';
import {
  startHttpServer,
  readJsonBody,
  sendJson,
  type HttpServerHandle,
} from '../../src/http/server.js';

const HOST = '127.0.0.1';
const log = () => createLogger({ level: 'silent' });

let handle: HttpServerHandle | undefined;
let base: string;

async function start(opts: Record<string, unknown> = {}): Promise<void> {
  handle = await startHttpServer({ port: 0, host: HOST, logger: log(), ...opts });
  base = `http://${HOST}:${handle.port}`;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
});

describe('HTTP server routing and isolation', () => {
  it('GET /livez returns 200 ok by default and reflects the health probe', async () => {
    await start();
    const ok = await fetch(`${base}/livez`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'ok' });

    await start({ healthProbe: async () => ({ ok: false, error: 'db_down' }) });
    const down = await fetch(`${base}/livez`);
    expect(down.status).toBe(503);
    expect((await down.json()).error).toBe('db_down');
  });

  it('GET /readyz is not-ready until a probe says otherwise', async () => {
    await start();
    const unready = await fetch(`${base}/readyz`);
    expect(unready.status).toBe(503);

    await start({ readinessProbe: () => ({ ok: true }) });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await ready.json()).status).toBe('ready');
  });

  it('GET /status is disabled (404) when no admin token is configured', async () => {
    await start({ statusProvider: () => ({ uptime: 1 }) });
    const res = await fetch(`${base}/status`, {
      headers: { authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /status rejects bad/missing bearers and serves the snapshot on success', async () => {
    await start({
      adminToken: 's3cret-token',
      statusProvider: () => ({ version: '1.0.0', mode: 'observe' }),
    });

    const noAuth = await fetch(`${base}/status`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toBe('Bearer');

    const wrongAuth = await fetch(`${base}/status`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrongAuth.status).toBe(401);

    const ok = await fetch(`${base}/status`, {
      headers: { authorization: 'Bearer s3cret-token' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ version: '1.0.0', mode: 'observe' });
  });

  it('returns an identical 404 for unknown routes and disabled optional features', async () => {
    // No admin token, metrics, or mcp enabled.
    await start();

    const unknown = await fetch(`${base}/nope`);
    const status = await fetch(`${base}/status`);
    const metrics = await fetch(`${base}/metrics`);
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });

    for (const res of [unknown, status, metrics, mcp]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
      // Same hardening headers on every error path.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('rejects methods the routes do not use with 405', async () => {
    await start();
    const res = await fetch(`${base}/livez`, { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('serves configured OAuth discovery documents and 404s them when unconfigured', async () => {
    const prm = { resource: 'https://example.test/mcp', authorization_servers: ['https://example.test'] };

    // Unconfigured: the well-known path is indistinguishable from any unknown route.
    await start();
    const off = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: 'not_found' });

    await start({ oauthMetadataRoutes: { '/.well-known/oauth-protected-resource/mcp': prm } });
    const on = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual(prm);
    expect(on.headers.get('content-type')).toContain('application/json');
    // Discovery documents are stable and re-fetched often; they may be cached.
    expect(on.headers.get('cache-control')).toBe('public, max-age=300');

    // A path that was not configured still 404s, and POST is not a discovery verb.
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('serves discovery documents without a credential', async () => {
    // The documents must be readable before a client holds any token, or the
    // sign-in flow deadlocks: it cannot learn where to sign in.
    const prm = { resource: 'https://example.test/mcp' };
    await start({
      adminToken: 'admin-secret',
      oauthMetadataRoutes: { '/.well-known/oauth-protected-resource': prm },
    });
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(prm);
  });

  it('records unmatched routes without the query string that may hold a credential', async () => {
    const logger = createLogger({ level: 'silent' });
    const records: Record<string, unknown>[] = [];
    vi.spyOn(logger, 'info').mockImplementation(((obj: unknown) => {
      records.push(obj as Record<string, unknown>);
    }) as never);

    handle = await startHttpServer({ port: 0, host: HOST, logger });
    base = `http://${HOST}:${handle.port}`;

    // The paths a remote MCP client probes after an unauthenticated request.
    await fetch(`${base}/.well-known/oauth-protected-resource/mcp?secret=leak`, {
      headers: { 'user-agent': 'probe/1.0' },
    });
    await fetch(`${base}/register`, { method: 'POST', body: '{}' });
    await fetch(`${base}/livez`, { method: 'PUT' });

    const unmatched = records.filter((r) => r.event === 'http.unmatched_route');
    expect(unmatched).toEqual([
      {
        event: 'http.unmatched_route',
        method: 'GET',
        path: '/.well-known/oauth-protected-resource/mcp',
        reason: 'unknown_route',
        userAgent: 'probe/1.0',
      },
      expect.objectContaining({ method: 'POST', path: '/register', reason: 'unknown_route' }),
      expect.objectContaining({ path: '/livez', reason: 'method_not_allowed' }),
    ]);
    // No record may carry the query string a client wrongly used for a token.
    expect(JSON.stringify(unmatched)).not.toContain('leak');
  });

  it('delivers enabled /metrics and /mcp routes to their handlers', async () => {
    await start({
      metricsEnabled: true,
      metricsHandler: (_req, res) => sendJson(res, 200, { metrics: 'text' }),
      mcpEnabled: true,
      mcpHandler: async (req, res) => {
        const r = await readJsonBody(req, 4096);
        if (!r.ok) return sendJson(res, r.status, { error: r.error });
        sendJson(res, 200, { echo: r.value });
      },
    });

    const m = await fetch(`${base}/metrics`);
    expect(m.status).toBe(200);
    expect(await m.json()).toEqual({ metrics: 'text' });

    const rpc = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'search_messages', q: 'x' }),
    });
    expect(rpc.status).toBe(200);
    expect(await rpc.json()).toEqual({ echo: { tool: 'search_messages', q: 'x' } });
  });

  it('caps request bodies with 413 and rejects malformed JSON with 400', async () => {
    await start({
      mcpEnabled: true,
      mcpHandler: async (req, res) => {
        const r = await readJsonBody(req, 32);
        if (!r.ok) return sendJson(res, r.status, { error: r.error });
        sendJson(res, 200, {});
      },
    });

    const tooBig = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: 'x'.repeat(200),
    });
    expect(tooBig.status).toBe(413);

    const badJson = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error).toBe('invalid_json');
  });

  it('never crashes on malformed protocol-level requests', async () => {
    await start();

    // Send raw invalid bytes on a fresh socket — handled by 'clientError'.
    await new Promise<void>((resolve) => {
      const sock = connect(handle!.port, HOST);
      sock.on('connect', () => {
        sock.write('THIS IS NOT HTTP/1.1\r\nGARBAGE\r\n\r\n');
      });
      sock.on('data', () => {
        /* server responds 400 then closes */
      });
      sock.on('close', () => resolve());
      sock.on('error', () => resolve());
    });

    // Server is still alive and serving.
    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
  });

  it('returns a safe 500 (no internal details) when a handler throws', async () => {
    const logger = createLogger({ level: 'silent' });
    const warnings: Record<string, unknown>[] = [];
    vi.spyOn(logger, 'warn').mockImplementation(((obj: unknown) => {
      warnings.push(obj as Record<string, unknown>);
    }) as never);
    handle = await startHttpServer({ port: 0, host: HOST, logger,
      adminToken: 't',
      statusProvider: async () => {
        throw new Error('db exploded with secret xyz');
      },
    });
    base = `http://${HOST}:${handle.port}`;
    const res = await fetch(`${base}/status?code=oauth-code-canary&state=state-canary`, {
      headers: { authorization: 'Bearer t' },
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe(JSON.stringify({ error: 'internal' }));
    expect(body).not.toContain('secret');
    expect(body).not.toContain('xyz');
    expect(warnings).toContainEqual(expect.objectContaining({
      event: 'http.unhandled_error', path: '/status',
    }));
    expect(JSON.stringify(warnings)).not.toContain('oauth-code-canary');
    expect(JSON.stringify(warnings)).not.toContain('state-canary');

    // Process is unharmed.
    const live = await fetch(`${base}/livez`);
    expect(live.status).toBe(200);
  });

  it('a probe that throws degrades to 503 without crashing', async () => {
    await start({ healthProbe: async () => Promise.reject(new Error('boom')) });
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(503);
  });
});
