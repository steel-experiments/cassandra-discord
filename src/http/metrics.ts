import type { ServerResponse } from 'node:http';
import { bearerOk, sendJson, type RouteHandler } from './server.js';
import {
  SECTION_33_METRICS,
  type Counters,
  type MetricDefinition,
  type MetricSample,
} from '../observability.js';

/**
 * Optional Prometheus metrics endpoint (Section 32.4 / 33; task T107).
 *
 * Renders the in-process {@link Counters} registry (Section 33) in the
 * Prometheus text exposition format (version 0.0.4), behind the same
 * constant-time admin bearer check `/status` uses (Section 32.3). No third-party
 * metrics library is needed: the format is a few lines of HELP/TYPE plus one
 * line per sample, and our counters are plain `{name, labels, value, kind}`.
 *
 * Authorization is reused, not re-implemented: the handler calls the exported
 * {@link bearerOk} from the HTTP server. When no admin token is configured the
 * handler returns the identical `404` an unknown route returns, so the endpoint
 * is not discoverable — the same posture as `/status` and a disabled `/mcp`.
 *
 * Label safety (Section 33): only label names declared for a metric in
 * {@link SECTION_33_METRICS} are emitted, and any single label value is capped
 * in length. Together these guarantee the exposition contains no
 * content-derived, high-cardinality labels — a misuse that stuffed message text
 * into a label is silently dropped at render time, never scraped.
 */

/** Prometheus text exposition content type (version 0.0.4). */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Maximum length of a single emitted label value. Real labels are short enums
 * (action, type, stage); anything longer is treated as likely content and
 * dropped, bounding the label cardinality the endpoint can ever expose.
 */
export const MAX_LABEL_VALUE_LENGTH = 128;

/** A declared metric looked up by name, for HELP text and label allowlisting. */
const DEFINITIONS: ReadonlyMap<string, MetricDefinition> = new Map(
  SECTION_33_METRICS.map((d) => [d.name, d]),
);

/** Dependencies for {@link createMetricsHandler}. */
export interface MetricsHandlerDeps {
  /** The Section 33 counters registry to render. */
  counters: Counters;
  /**
   * Admin bearer token (same as `/status`). When undefined the handler returns
   * `404`, identical to a disabled endpoint.
   */
  adminToken: string | undefined;
}

/**
 * Build the `/metrics` route handler. The HTTP layer calls this only when
 * `metricsEnabled` is true (Section 32.4); the handler additionally requires the
 * admin token and a valid bearer before rendering.
 */
export function createMetricsHandler(deps: MetricsHandlerDeps): RouteHandler {
  return (req, res) => {
    // Reuse status authorization (Section 32.4): a missing admin token makes the
    // endpoint indistinguishable from an absent route.
    if (!deps.adminToken) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!bearerOk(req, deps.adminToken)) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    const body = renderPrometheusText(deps.counters.snapshot());
    sendText(res, 200, body);
  };
}

/**
 * Render metric samples as Prometheus text. Samples are expected pre-sorted by
 * name then labels (as {@link Counters.snapshot} returns), so each metric family
 * is contiguous and its `# HELP` / `# TYPE` lines are emitted once, on the first
 * sample of the family. Returns a trailing newline when non-empty.
 */
export function renderPrometheusText(samples: readonly MetricSample[]): string {
  const lines: string[] = [];
  let lastName = '';
  for (const sample of samples) {
    if (sample.name !== lastName) {
      const def = DEFINITIONS.get(sample.name);
      if (def) {
        lines.push(`# HELP ${sample.name} ${def.help}`);
      }
      lines.push(`# TYPE ${sample.name} ${sample.kind}`);
      lastName = sample.name;
    }
    const labels = allowedLabels(sample);
    lines.push(`${sample.name}${formatLabels(labels)} ${formatValue(sample.value)}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * The label set emitted for a sample, filtered to the metric's declared label
 * names and capped per-value length. Undeclared keys and over-long values are
 * dropped — the defense against content-derived high-cardinality labels. Sorted
 * by key, as Prometheus requires.
 */
function allowedLabels(sample: MetricSample): Array<[string, string]> {
  const def = DEFINITIONS.get(sample.name);
  const allowedKeys = new Set<string>(def?.labelNames ?? []);
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(sample.labels)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value !== 'string') continue;
    if (value.length === 0 || value.length > MAX_LABEL_VALUE_LENGTH) continue;
    out.push([key, value]);
  }
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** Format a label set as Prometheus `{k="v",k2="v2"}`, or `''` when empty. */
function formatLabels(labels: Array<[string, string]>): string {
  if (labels.length === 0) return '';
  return `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

/** Escape the Prometheus label-value special characters (Section 33 exposition). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Format a sample value: integers without a decimal point, finite floats as-is. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value) ? String(value) : String(value);
}

/** Write a text response with the same hardening headers as JSON responses. */
function sendText(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
    return;
  }
  res.writeHead(status, {
    'content-type': METRICS_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(body);
}
