/**
 * Operational counters and alert-state derivation (Section 33; task T106).
 *
 * Section 33 names two families of observability output:
 *
 * 1. **Key counters** — cumulative process-lifetime totals (messages ingested,
 *    duplicate messages ignored, Gateway reconnects, channels discovered,
 *    channels inaccessible, backfill pages and messages, job queue depth and
 *    failures, episodes opened/closed/reviewed, model calls/tokens/cost/latency/
 *    failures, memory proposals by action/type, interventions proposed/reviewed/
 *    sent/dismissed, policy rejections, outbox retries, database/WAL size).
 * 2. **Alert conditions** — derivable from current state: no Gateway event while
 *    Discord reports ready, repeated reconnects, oldest queued review past SLA, a
 *    channel stuck in sync error, volume over threshold, WAL growing without
 *    checkpoint, model budget exceeded, backup stale, integrity check failed.
 *
 * This module is the pure engine for both. {@link createCounters} builds an
 * in-process registry of monotonic counters and gauges (the values that are not
 * recoverable from a database query — reconnects, cumulative model cost, policy
 * rejections, outbox retries, and so on); {@link deriveAlerts} turns a synthetic
 * point-in-time state into the active alert set. Neither touches the database,
 * the logger, or any message content: counters are names, low-cardinality
 * labels, and numbers; alerts are a kind, a severity, and a numeric detail
 * string. The Prometheus renderer (T107) consumes {@link MetricSample} directly.
 *
 * Privacy by construction (Section 33): there is no field, parameter, or code
 * path here that accepts or emits message content, prompt bodies, tokens, or
 * authorization material. A sample is exactly `{name, labels, value, kind}` and
 * an alert is exactly `{kind, severity, detail}` — the test suite asserts both
 * shapes so a content field cannot be added silently.
 */

/** Whether a metric is a monotonic counter or an arbitrary gauge. */
export type MetricKind = 'counter' | 'gauge';

/** One observed metric value, in the shape Prometheus text expects. */
export interface MetricSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly kind: MetricKind;
}

/** A declared Section 33 metric, with help text for exposition (T107). */
export interface MetricDefinition {
  readonly name: string;
  readonly help: string;
  readonly kind: MetricKind;
  /** Low-cardinality label names this metric is partitioned by, if any. */
  readonly labelNames?: readonly string[];
}

/**
 * Stable Section 33 counter names. Counters are monotonic and use the Prometheus
 * `_total` suffix; they are incremented by event (`inc`) and never decremented.
 */
export const COUNTER_NAMES = {
  messagesIngested: 'messages_ingested_total',
  messagesDuplicate: 'messages_duplicate_total',
  gatewayReconnects: 'gateway_reconnects_total',
  channelsDiscovered: 'channels_discovered_total',
  channelsInaccessible: 'channels_inaccessible_total',
  backfillPages: 'backfill_pages_total',
  backfillMessages: 'backfill_messages_total',
  episodesOpened: 'episodes_opened_total',
  episodesClosed: 'episodes_closed_total',
  episodesReviewed: 'episodes_reviewed_total',
  modelCalls: 'model_calls_total',
  modelTokens: 'model_tokens_total',
  modelCost: 'model_cost_total',
  modelLatencyMs: 'model_latency_ms_total',
  modelFailures: 'model_failures_total',
  memoryProposals: 'memory_proposals_total',
  interventions: 'interventions_total',
  policyRejections: 'policy_rejections_total',
  outboxRetries: 'outbox_retries_total',
  ingestionEvents: 'ingestion_events_total',
  ingestionRecovery: 'ingestion_recovery_total',
} as const;

/**
 * Stable Section 33 gauge names. Gauges hold a current value (queue depth, byte
 * sizes) set with `set`; they have no `_total` suffix.
 */
export const GAUGE_NAMES = {
  jobQueueDepth: 'job_queue_depth',
  databaseSizeBytes: 'database_size_bytes',
  walSizeBytes: 'wal_size_bytes',
} as const;

/**
 * The canonical Section 33 metric set. Drives the "produce every counter"
 * acceptance test and gives the future Prometheus renderer its help text. Kept
 * in sync with {@link COUNTER_NAMES}/{@link GAUGE_NAMES} by a unit test that
 * asserts every declared name appears here exactly once.
 */
export const SECTION_33_METRICS: readonly MetricDefinition[] = [
  { name: COUNTER_NAMES.messagesIngested, kind: 'counter', help: 'Discord messages ingested.' },
  { name: COUNTER_NAMES.messagesDuplicate, kind: 'counter', help: 'Duplicate messages ignored.' },
  { name: COUNTER_NAMES.gatewayReconnects, kind: 'counter', help: 'Gateway reconnects.' },
  { name: COUNTER_NAMES.channelsDiscovered, kind: 'counter', help: 'Channels discovered.' },
  { name: COUNTER_NAMES.channelsInaccessible, kind: 'counter', help: 'Channels found inaccessible.' },
  { name: COUNTER_NAMES.backfillPages, kind: 'counter', help: 'Backfill pages fetched.' },
  { name: COUNTER_NAMES.backfillMessages, kind: 'counter', help: 'Backfill messages archived.' },
  { name: COUNTER_NAMES.episodesOpened, kind: 'counter', help: 'Episodes opened.' },
  { name: COUNTER_NAMES.episodesClosed, kind: 'counter', help: 'Episodes closed.' },
  { name: COUNTER_NAMES.episodesReviewed, kind: 'counter', help: 'Episodes reviewed.' },
  { name: COUNTER_NAMES.modelCalls, kind: 'counter', help: 'Model calls attempted.' },
  { name: COUNTER_NAMES.modelTokens, kind: 'counter', help: 'Model tokens used (prompt + completion).' },
  { name: COUNTER_NAMES.modelCost, kind: 'counter', help: 'Cumulative model cost (currency units).' },
  { name: COUNTER_NAMES.modelLatencyMs, kind: 'counter', help: 'Cumulative model latency in milliseconds.' },
  { name: COUNTER_NAMES.modelFailures, kind: 'counter', help: 'Model call failures.' },
  {
    name: COUNTER_NAMES.memoryProposals,
    kind: 'counter',
    help: 'Memory proposals by action and type.',
    labelNames: ['action', 'type'],
  },
  {
    name: COUNTER_NAMES.interventions,
    kind: 'counter',
    help: 'Interventions by stage (proposed/reviewed/sent/dismissed).',
    labelNames: ['stage'],
  },
  { name: COUNTER_NAMES.policyRejections, kind: 'counter', help: 'Policy rejections.' },
  { name: COUNTER_NAMES.outboxRetries, kind: 'counter', help: 'Outbox send retries.' },
  {
    name: COUNTER_NAMES.ingestionEvents, kind: 'counter',
    help: 'Gateway ingestion outcomes by event type, outcome, and reason.',
    labelNames: ['event_type', 'outcome', 'reason'],
  },
  {
    name: COUNTER_NAMES.ingestionRecovery, kind: 'counter',
    help: 'Durable ingestion recovery transitions by outcome and reason.',
    labelNames: ['outcome', 'reason'],
  },
  { name: GAUGE_NAMES.jobQueueDepth, kind: 'gauge', help: 'Current job queue depth.' },
  { name: GAUGE_NAMES.databaseSizeBytes, kind: 'gauge', help: 'Database file size in bytes.' },
  { name: GAUGE_NAMES.walSizeBytes, kind: 'gauge', help: 'Write-ahead log size in bytes.' },
];

/** Registry of cumulative counters and current gauges (Section 33). */
export interface Counters {
  /**
   * Increment a monotonic counter by `by` (default 1). The metric's kind is fixed
   * at first touch; calling `inc` on a name previously `set` as a gauge throws —
   * a counter/gauge name collision is a wiring bug.
   */
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  /**
   * Set a gauge to `value`. Calling `set` on a name previously `inc`'d as a
   * counter throws for the same reason.
   */
  set(name: string, value: number, labels?: Record<string, string>): void;
  /** Current value of a metric (counter or gauge); 0 when never touched. */
  get(name: string, labels?: Record<string, string>): number;
  /** Whether a metric has been touched at the given labels. */
  has(name: string, labels?: Record<string, string>): boolean;
  /** All observed samples, sorted by name then label for deterministic output. */
  snapshot(): readonly MetricSample[];
  /** Drop all samples (test isolation). */
  reset(): void;
}

/** Finite, content-free dimensions accepted by the ingestion metrics. */
export type IngestionOutcome = 'persisted' | 'duplicate' | 'policy_skipped' | 'recovery_queued' | 'failed';
export type IngestionReason = 'none' | 'policy' | 'missing_channel' | 'missing_message'
  | 'foreign_key' | 'malformed_payload' | 'unavailable_source' | 'unexpected_exception';
export type RecoveryOutcome = 'succeeded' | 'deferred' | 'unavailable' | 'skipped' | 'expired';
export type RecoveryReason = 'none' | 'missing_channel' | 'missing_message' | 'parent_missing'
  | 'policy' | 'unavailable_source';

export interface IngestionObserver {
  event(eventType: string, outcome: IngestionOutcome, reason: IngestionReason): void;
  recovery(outcome: RecoveryOutcome, reason: RecoveryReason): void;
}

/** Bind only allowlisted ingestion/recovery dimensions to the shared registry. */
export function createIngestionObserver(counters: Counters): IngestionObserver {
  return {
    event(eventType, outcome, reason) {
      counters.inc(COUNTER_NAMES.ingestionEvents, { event_type: eventType, outcome, reason });
    },
    recovery(outcome, reason) {
      counters.inc(COUNTER_NAMES.ingestionRecovery, { outcome, reason });
    },
  };
}

interface StoredSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  kind: MetricKind;
}

/** Build an empty in-process counters registry. */
export function createCounters(): Counters {
  const samples = new Map<string, StoredSample>();

  function keyOf(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const entries = Object.entries(labels)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return name;
    return `${name}{${entries.map(([k, v]) => `${k}=${v}`).join(',')}}`;
  }

  function touch(name: string, labels: Record<string, string>, kind: MetricKind): StoredSample {
    const key = keyOf(name, labels);
    const existing = samples.get(key);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `metric '${name}' is already a ${existing.kind}; cannot use as ${kind}`,
        );
      }
      return existing;
    }
    const sample: StoredSample = { name, labels, value: 0, kind };
    samples.set(key, sample);
    return sample;
  }

  return {
    inc(name, labels, by = 1) {
      if (!Number.isFinite(by)) return;
      const sample = touch(name, normalizeLabels(labels), 'counter');
      sample.value += by;
    },
    set(name, value, labels) {
      if (!Number.isFinite(value)) return;
      const sample = touch(name, normalizeLabels(labels), 'gauge');
      sample.value = value;
    },
    get(name, labels) {
      return samples.get(keyOf(name, normalizeLabels(labels)))?.value ?? 0;
    },
    has(name, labels) {
      return samples.has(keyOf(name, normalizeLabels(labels)));
    },
    snapshot() {
      return [...samples.values()]
        .map((s) => ({ name: s.name, labels: freezeLabels(s.labels), value: s.value, kind: s.kind }))
        .sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : labelKey(a.labels) < labelKey(b.labels) ? -1 : 1,
        );
    },
    reset() {
      samples.clear();
    },
  };
}

/** Coerce a labels argument into a plain string→string record (empty when none). */
function normalizeLabels(labels?: Record<string, string>): Record<string, string> {
  if (!labels) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

/** Freeze the label record so a returned sample is immutable to the caller. */
function freezeLabels(labels: Record<string, string>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) out[k] = v;
  return Object.freeze(out);
}

/** Stable string key for a label set, for snapshot sorting. */
function labelKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

// ---------------------------------------------------------------------------
// Alert-state derivation (Section 33).
// ---------------------------------------------------------------------------

/** The Section 33 alert conditions, as stable identifiers. */
export type AlertKind =
  | 'gateway_stale'
  | 'gateway_repeated_reconnects'
  | 'review_sla_exceeded'
  | 'channel_sync_error'
  | 'volume_threshold_exceeded'
  | 'wal_growing_without_checkpoint'
  | 'model_budget_exceeded'
  | 'backup_stale'
  | 'database_integrity_failed';

/** Operator severity for routing (page vs. ticket). */
export type AlertSeverity = 'warning' | 'critical';

/** One active alert. `detail` carries counts/durations only, never content. */
export interface ActiveAlert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly detail: string;
}

/**
 * Configurable thresholds for each alert condition. Section 33 phrases several as
 * "a configurable period" or "exceeds threshold"; these defaults are conservative
 * starting points an operator overrides from configuration at the call site.
 */
export interface AlertThresholds {
  /** No Gateway event while ready beyond this age (ms). */
  gatewayStaleMs: number;
  /** Reconnect count above which reconnects are "repeated". */
  gatewayReconnectCount: number;
  /** Oldest queued review age beyond SLA (ms). */
  reviewSlaMs: number;
  /** Volume usage ratio (0..1) above which volume is over threshold. */
  volumeUsageRatio: number;
  /** WAL byte size above which growth is concerning. */
  walBytes: number;
  /** Time since the last checkpoint beyond which the WAL is considered stalled (ms). */
  walCheckpointStallMs: number;
  /** Model budget used ratio (0..1) above which the budget is exceeded. */
  modelBudgetRatio: number;
  /** Backup age beyond which a backup is stale (ms). */
  backupStaleMs: number;
}

/**
 * Default thresholds. Chosen as conservative, override-friendly values; they are
 * not spec-mandated numbers — Section 33 leaves the periods configurable.
 */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  gatewayStaleMs: 5 * 60_000,
  gatewayReconnectCount: 5,
  reviewSlaMs: 6 * 60 * 60_000,
  volumeUsageRatio: 0.85,
  walBytes: 100 * 1024 * 1024,
  walCheckpointStallMs: 5 * 60_000,
  modelBudgetRatio: 0.9,
  backupStaleMs: 24 * 60 * 60_000,
};

/**
 * The synthetic state {@link deriveAlerts} reasons over. Every field is a count,
 * size, timestamp, or ratio; none is message content, a prompt, or a credential.
 * `null` means "unknown / not applicable" and suppresses the corresponding alert
 * rather than firing it — an alert fires only when the relevant signal is known
 * and past threshold.
 */
export interface AlertInput {
  nowMs: number;
  gateway: {
    ready: boolean;
    /** Epoch ms of the most recent Gateway event, or null when none recorded. */
    lastEventAtMs: number | null;
    reconnectCount: number;
  };
  /** Age of the oldest queued review (ms), or null when the review queue is empty. */
  oldestQueuedReviewAgeMs: number | null;
  /** Number of channels currently in a sync-error state. */
  channelsInSyncError: number;
  /** Configured volume usage ratio (0..1), or null when volume is not tracked. */
  volumeUsageRatio: number | null;
  wal: {
    sizeBytes: number | null;
    /** Age of the most recent checkpoint (ms), or null when unknown. */
    lastCheckpointAgeMs: number | null;
  };
  /** Model budget used ratio (0..1), or null when no budget is configured. */
  modelBudgetUsedRatio: number | null;
  /** Age of the most recent backup (ms), or null when none has run. */
  backupAgeMs: number | null;
  /** Result of the most recent database integrity check. */
  databaseIntegrityOk: boolean;
}

/**
 * Derive the active Section 33 alert set from a synthetic state snapshot. Pure
 * and synchronous: given the same input and thresholds it returns the same
 * alerts, in a stable order (the declaration order of {@link AlertKind}). An
 * alert fires only when its signal is known and past threshold; unknown signals
 * (null) are silent. The returned `detail` strings are counts, sizes, and
 * durations only.
 */
export function deriveAlerts(
  input: AlertInput,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): ActiveAlert[] {
  const alerts: ActiveAlert[] = [];

  const { gateway } = input;
  if (
    gateway.ready &&
    gateway.lastEventAtMs !== null &&
    input.nowMs - gateway.lastEventAtMs > thresholds.gatewayStaleMs
  ) {
    const age = input.nowMs - gateway.lastEventAtMs;
    alerts.push({
      kind: 'gateway_stale',
      severity: 'critical',
      detail: `no gateway event for ${age}ms while ready (threshold ${thresholds.gatewayStaleMs}ms)`,
    });
  }

  if (gateway.reconnectCount > thresholds.gatewayReconnectCount) {
    alerts.push({
      kind: 'gateway_repeated_reconnects',
      severity: 'warning',
      detail: `${gateway.reconnectCount} reconnects (threshold ${thresholds.gatewayReconnectCount})`,
    });
  }

  if (
    input.oldestQueuedReviewAgeMs !== null &&
    input.oldestQueuedReviewAgeMs > thresholds.reviewSlaMs
  ) {
    alerts.push({
      kind: 'review_sla_exceeded',
      severity: 'warning',
      detail: `oldest queued review ${input.oldestQueuedReviewAgeMs}ms old (sla ${thresholds.reviewSlaMs}ms)`,
    });
  }

  if (input.channelsInSyncError > 0) {
    alerts.push({
      kind: 'channel_sync_error',
      severity: 'warning',
      detail: `${input.channelsInSyncError} channel(s) in sync error`,
    });
  }

  if (
    input.volumeUsageRatio !== null &&
    input.volumeUsageRatio > thresholds.volumeUsageRatio
  ) {
    alerts.push({
      kind: 'volume_threshold_exceeded',
      severity: 'warning',
      detail: `volume usage ${input.volumeUsageRatio.toFixed(3)} (threshold ${thresholds.volumeUsageRatio.toFixed(3)})`,
    });
  }

  const walLarge = input.wal.sizeBytes !== null && input.wal.sizeBytes > thresholds.walBytes;
  const walStalled =
    input.wal.lastCheckpointAgeMs !== null &&
    input.wal.lastCheckpointAgeMs > thresholds.walCheckpointStallMs;
  if (walLarge && walStalled) {
    alerts.push({
      kind: 'wal_growing_without_checkpoint',
      severity: 'warning',
      detail: `wal ${input.wal.sizeBytes} bytes, last checkpoint ${input.wal.lastCheckpointAgeMs}ms ago`,
    });
  }

  if (
    input.modelBudgetUsedRatio !== null &&
    input.modelBudgetUsedRatio > thresholds.modelBudgetRatio
  ) {
    alerts.push({
      kind: 'model_budget_exceeded',
      severity: 'critical',
      detail: `model budget ${input.modelBudgetUsedRatio.toFixed(3)} used (threshold ${thresholds.modelBudgetRatio.toFixed(3)})`,
    });
  }

  if (input.backupAgeMs !== null && input.backupAgeMs > thresholds.backupStaleMs) {
    alerts.push({
      kind: 'backup_stale',
      severity: 'critical',
      detail: `last backup ${input.backupAgeMs}ms ago (threshold ${thresholds.backupStaleMs}ms)`,
    });
  }

  if (!input.databaseIntegrityOk) {
    alerts.push({
      kind: 'database_integrity_failed',
      severity: 'critical',
      detail: 'database integrity check failed',
    });
  }

  return alerts;
}

/**
 * A convenience that combines a counters snapshot with derived alerts into one
 * privacy-safe exposition record — counts, sizes, durations, and alert kinds
 * only. Used by the status endpoint and (later) the Prometheus renderer; it
 * never accepts or returns message content.
 */
export interface ObservabilityReport {
  readonly metrics: readonly MetricSample[];
  readonly alerts: readonly ActiveAlert[];
}

/** Build an {@link ObservabilityReport} from a counters registry and alert input. */
export function buildObservabilityReport(
  counters: Counters,
  input: AlertInput,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): ObservabilityReport {
  return {
    metrics: counters.snapshot(),
    alerts: deriveAlerts(input, thresholds),
  };
}
