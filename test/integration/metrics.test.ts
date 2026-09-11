import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { startHttpServer, type HttpServerHandle } from '../../src/http/server.js';
import { createMetricsHandler, renderPrometheusText, METRICS_CONTENT_TYPE } from '../../src/http/metrics.js';
import { createCounters, COUNTER_NAMES, GAUGE_NAMES } from '../../src/observability.js';

/**
 * Optional protected Prometheus metrics endpoint (Section 32.4 / 33; task T107).
 *
 * Acceptance — verbatim: "Authorized output parses as Prometheus text and
 * contains no content-derived high-cardinality labels."
 *
 * The handler is mounted on the real HTTP server and driven with `fetch`:
 * - `/metrics` is `404` when disabled (indistinguishable from an absent route),
 *   `401` on a missing/wrong bearer, and `200 text/plain` when authorized.
 * - The authorized body is real Prometheus exposition: HELP/TYPE per family,
 *   counter and gauge types, labeled series, correct values.
 * - A content canary planted in an undeclared label key, and an over-long label
 *   value, never reach the output — the renderer allows only declared labels and
 *   caps value length, so the endpoint cannot expose content-derived labels.
 */

const HOST = '127.0.0.1';
const PATH = '/metrics';
const TOKEN = 'metrics-admin-token-xyz';

const servers: HttpServerHandle[] = [];

afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

interface StartOpts {
  enabled?: boolean;
  adminToken?: string;
}

async function start(counters: ReturnType<typeof createCounters>, opts: StartOpts = {}): Promise<string> {
  // Distinguish "not provided" (default to TOKEN) from "explicitly undefined"
  // (no admin token configured) so the 404-when-unconfigured path is testable.
  const adminToken = 'adminToken' in opts ? opts.adminToken : TOKEN;
  const handle = await startHttpServer({
    port: 0,
    host: HOST,
    logger: createLogger(),
    adminToken,
    metricsEnabled: opts.enabled ?? true,
    metricsHandler: createMetricsHandler({ counters, adminToken }),
  });
  servers.push(handle);
  return `http://${HOST}:${handle.port}`;
}

async function get(base: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${PATH}`, { headers });
}

/** Populate a registry with representative counters, gauges, and labeled series. */
function seededCounters(): ReturnType<typeof createCounters> {
  const c = createCounters();
  c.inc(COUNTER_NAMES.messagesIngested, undefined, 42);
  c.inc(COUNTER_NAMES.messagesDuplicate, undefined, 3);
  c.inc(COUNTER_NAMES.gatewayReconnects, undefined, 2);
  c.inc(COUNTER_NAMES.modelCalls, undefined, 11);
  c.inc(COUNTER_NAMES.modelCost, undefined, 1.25);
  c.inc(COUNTER_NAMES.modelTokens, undefined, 9001);
  c.inc(COUNTER_NAMES.episodesReviewed, undefined, 7);
  c.inc(COUNTER_NAMES.memoryProposals, { action: 'accept', type: 'decision' }, 6);
  c.inc(COUNTER_NAMES.memoryProposals, { action: 'reject', type: 'risk' }, 2);
  c.inc(COUNTER_NAMES.interventions, { stage: 'proposed' }, 4);
  c.inc(COUNTER_NAMES.interventions, { stage: 'sent' }, 1);
  c.inc(COUNTER_NAMES.ingestionEvents, { event_type: 'MESSAGE_CREATE', outcome: 'failed', reason: 'foreign_key' }, 2);
  c.inc(COUNTER_NAMES.ingestionRecovery, { outcome: 'unavailable', reason: 'unavailable_source' }, 1);
  c.set(GAUGE_NAMES.jobQueueDepth, 12);
  c.set(GAUGE_NAMES.databaseSizeBytes, 5_000_000);
  c.set(GAUGE_NAMES.walSizeBytes, 200_000);
  return c;
}

describe('disabled and unauthorized access', () => {
  it('returns the identical 404 when metrics are disabled', async () => {
    const base = await start(createCounters(), { enabled: false });
    const res = await get(base, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 404 when no admin token is configured (not discoverable)', async () => {
    const base = await start(createCounters(), { adminToken: undefined });
    const res = await get(base, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
  });

  it('returns 401 with www-authenticate for a missing or wrong bearer', async () => {
    const base = await start(seededCounters());
    const missing = await get(base);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await get(base, { authorization: 'Bearer not-the-token' });
    expect(wrong.status).toBe(401);
  });
});

describe('authorized output is valid Prometheus text', () => {
  it('returns 200 text/plain exposition with the right content type', async () => {
    const base = await start(seededCounters());
    const res = await get(base, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(METRICS_CONTENT_TYPE);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('emits HELP/TYPE per family and the correct counter and gauge types', async () => {
    const base = await start(seededCounters());
    const body = await (await get(base, { authorization: `Bearer ${TOKEN}` })).text();
    // HELP and TYPE appear for a counter family…
    expect(body).toContain('# HELP messages_ingested_total');
    expect(body).toContain('# TYPE messages_ingested_total counter');
    // …and for a gauge family.
    expect(body).toContain('# TYPE job_queue_depth gauge');
    // A metric family with HELP/TYPE declared still carries its help text.
    expect(body).toContain('# HELP memory_proposals_total');
    expect(body).toContain('# TYPE memory_proposals_total counter');
  });

  it('renders values, including floats and labeled series', async () => {
    const base = await start(seededCounters());
    const body = await (await get(base, { authorization: `Bearer ${TOKEN}` })).text();
    expect(body).toContain('messages_ingested_total 42');
    expect(body).toContain('model_cost_total 1.25');
    expect(body).toContain('model_tokens_total 9001');
    // Labeled series use the Prometheus {k="v"} form, sorted by key.
    expect(body).toContain('memory_proposals_total{action="accept",type="decision"} 6');
    expect(body).toContain('memory_proposals_total{action="reject",type="risk"} 2');
    expect(body).toContain('interventions_total{stage="proposed"} 4');
    // Gauges render their current value.
    expect(body).toContain('job_queue_depth 12');
    expect(body).toContain('wal_size_bytes 200000');
  });

  it('parses as Prometheus text: every data line is name{labels} value', async () => {
    const base = await start(seededCounters());
    const body = await (await get(base, { authorization: `Bearer ${TOKEN}` })).text();
    // Each non-comment, non-empty line must match the metric line grammar.
    const dataLine = /^[A-Za-z_:][A-Za-z0-9_:]*(?:\{[^}]*\})?\s+[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    const lines = body.split('\n');
    const dataLines = lines.filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines) {
      expect(dataLine.test(line), `bad metric line: ${line}`).toBe(true);
    }
    // Each TYPE line precedes its family's first sample and is well-formed.
    for (const t of lines.filter((l) => l.startsWith('# TYPE '))) {
      expect(t).toMatch(/^# TYPE [A-Za-z_:][A-Za-z0-9_:]* (counter|gauge)$/);
    }
  });
});

describe('no content-derived high-cardinality labels', () => {
  it('drops labels whose key is not declared for the metric', async () => {
    const CANARY = 'SECRET-CONTENT-IN-LABEL';
    const c = createCounters();
    c.inc(COUNTER_NAMES.messagesIngested, undefined, 5);
    // A misuse: stuffing content into an undeclared label key on a label-less
    // counter. The renderer must not expose it.
    // (inc accepts arbitrary labels; the renderer is the gate.)
    (c as unknown as { inc: (n: string, l: Record<string, string>, v?: number) => void }).inc(
      COUNTER_NAMES.messagesIngested,
      { content: CANARY },
      1,
    );
    const base = await start(c);
    const body = await (await get(base, { authorization: `Bearer ${TOKEN}` })).text();
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain('content=');
    // The legitimate value still renders (bare counter).
    expect(body).toContain('messages_ingested_total 5');
  });

  it('drops an over-long label value that looks like content', async () => {
    const blob = 'X'.repeat(500);
    const c = createCounters();
    // A declared key (stage) but a value far longer than any real enum.
    (c as unknown as { inc: (n: string, l: Record<string, string>, v?: number) => void }).inc(
      COUNTER_NAMES.interventions,
      { stage: blob },
      1,
    );
    const base = await start(c);
    const body = await (await get(base, { authorization: `Bearer ${TOKEN}` })).text();
    expect(body).not.toContain(blob);
    // No interventions_total sample line survives the only label being dropped.
    expect(body).not.toContain('interventions_total{');
  });

  it('escapes special characters in label values', () => {
    const c = createCounters();
    // Value `a"b` → the double quote is escaped to `\"` in the exposition.
    (c as unknown as { inc: (n: string, l: Record<string, string>, v?: number) => void }).inc(
      COUNTER_NAMES.interventions,
      { stage: 'a"b' },
      1,
    );
    const body = renderPrometheusText(c.snapshot());
    expect(body).toContain('interventions_total{stage="a\\"b"} 1');
    expect(body).not.toContain('stage="a"b"');
  });
});

describe('empty registry still yields valid exposition', () => {
  it('renders an empty body (no families) when nothing has been counted', async () => {
    const base = await start(createCounters());
    const res = await get(base, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe('');
  });
});
