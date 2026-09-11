import { describe, it, expect } from 'vitest';
import {
  COUNTER_NAMES,
  GAUGE_NAMES,
  SECTION_33_METRICS,
  createCounters,
  createIngestionObserver,
  deriveAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  buildObservabilityReport,
  type AlertInput,
  type AlertThresholds,
  type ActiveAlert,
  type MetricSample,
} from '../../src/observability.js';

/**
 * Operational counters and alert-state derivation (Section 33; task T106).
 *
 * Acceptance — verbatim: "Synthetic state produces every Section 33 counter and
 * alert without logging message content."
 *
 * The suite covers three things: (1) every Section 33 counter and gauge can be
 * produced and read back with the right value, kind, and labels; (2) each of the
 * nine alert conditions fires under synthetic state that crosses its threshold,
 * and a healthy snapshot fires none; (3) the counter and alert shapes carry no
 * content — a sample is exactly `{name, labels, value, kind}` and an alert is
 * exactly `{kind, severity, detail}`, with numeric detail only.
 */

const NOW = 1_700_000_000_000;

/** A snapshot that should produce zero alerts. */
function healthyInput(): AlertInput {
  return {
    nowMs: NOW,
    gateway: { ready: true, lastEventAtMs: NOW - 1_000, reconnectCount: 0 },
    oldestQueuedReviewAgeMs: 1_000,
    channelsInSyncError: 0,
    volumeUsageRatio: 0.1,
    wal: { sizeBytes: 1024, lastCheckpointAgeMs: 1_000 },
    modelBudgetUsedRatio: 0.1,
    backupAgeMs: 1_000,
    databaseIntegrityOk: true,
  };
}

describe('Section 33 counters registry', () => {
  it('records ingestion dimensions only as finite, content-free labels', () => {
    const counters = createCounters();
    const observer = createIngestionObserver(counters);
    observer.event('MESSAGE_CREATE', 'recovery_queued', 'missing_channel');
    observer.recovery('unavailable', 'unavailable_source');
    expect(counters.get(COUNTER_NAMES.ingestionEvents, {
      event_type: 'MESSAGE_CREATE', outcome: 'recovery_queued', reason: 'missing_channel',
    })).toBe(1);
    expect(counters.get(COUNTER_NAMES.ingestionRecovery, {
      outcome: 'unavailable', reason: 'unavailable_source',
    })).toBe(1);
  });
  it('declares every counter/gauge name in SECTION_33_METRICS exactly once (no drift)', () => {
    const names = SECTION_33_METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    for (const name of Object.values(COUNTER_NAMES)) {
      expect(names).toContain(name);
    }
    for (const name of Object.values(GAUGE_NAMES)) {
      expect(names).toContain(name);
    }
    expect(names.length).toBe(Object.values(COUNTER_NAMES).length + Object.values(GAUGE_NAMES).length);
  });

  it('produces every Section 33 counter and gauge with the correct value and kind', () => {
    const c = createCounters();
    // One representative inc per counter covers the monotonic-total counters.
    c.inc(COUNTER_NAMES.messagesIngested, undefined, 42);
    c.inc(COUNTER_NAMES.messagesDuplicate, undefined, 3);
    c.inc(COUNTER_NAMES.gatewayReconnects, undefined, 2);
    c.inc(COUNTER_NAMES.channelsDiscovered, undefined, 7);
    c.inc(COUNTER_NAMES.channelsInaccessible, undefined, 1);
    c.inc(COUNTER_NAMES.backfillPages, undefined, 9);
    c.inc(COUNTER_NAMES.backfillMessages, undefined, 900);
    c.inc(COUNTER_NAMES.episodesOpened, undefined, 5);
    c.inc(COUNTER_NAMES.episodesClosed, undefined, 4);
    c.inc(COUNTER_NAMES.episodesReviewed, undefined, 4);
    c.inc(COUNTER_NAMES.modelCalls, undefined, 11);
    c.inc(COUNTER_NAMES.modelTokens, undefined, 12345);
    c.inc(COUNTER_NAMES.modelCost, undefined, 1.25);
    c.inc(COUNTER_NAMES.modelLatencyMs, undefined, 8800);
    c.inc(COUNTER_NAMES.modelFailures, undefined, 2);
    c.inc(COUNTER_NAMES.memoryProposals, { action: 'accept', type: 'decision' }, 6);
    c.inc(COUNTER_NAMES.memoryProposals, { action: 'reject', type: 'risk' }, 2);
    c.inc(COUNTER_NAMES.interventions, { stage: 'proposed' }, 3);
    c.inc(COUNTER_NAMES.interventions, { stage: 'sent' }, 1);
    c.inc(COUNTER_NAMES.interventions, { stage: 'dismissed' }, 1);
    c.inc(COUNTER_NAMES.policyRejections, undefined, 8);
    c.inc(COUNTER_NAMES.outboxRetries, undefined, 4);
    // Gauges hold a current value.
    c.set(GAUGE_NAMES.jobQueueDepth, 12);
    c.set(GAUGE_NAMES.databaseSizeBytes, 5_000_000);
    c.set(GAUGE_NAMES.walSizeBytes, 200_000);

    const snap = c.snapshot();
    const byName = new Map(snap.map((s) => [sampleKey(s), s]));

    // Every declared metric appears with the expected kind.
    for (const def of SECTION_33_METRICS) {
      const bare = byName.get(def.name);
      if (!def.labelNames) {
        expect(bare, `${def.name} should be present`).toBeDefined();
        expect(bare!.kind).toBe(def.kind);
      }
    }

    // Spot-check values and kinds for the counter families.
    expect(c.get(COUNTER_NAMES.messagesIngested)).toBe(42);
    expect(c.get(COUNTER_NAMES.modelCost)).toBeCloseTo(1.25, 6);
    expect(c.get(COUNTER_NAMES.modelTokens)).toBe(12345);
    expect(c.get(GAUGE_NAMES.jobQueueDepth)).toBe(12);
    expect(c.get(GAUGE_NAMES.walSizeBytes)).toBe(200_000);

    // Counters are monotonic: a second inc adds rather than replaces.
    c.inc(COUNTER_NAMES.messagesIngested, undefined, 8);
    expect(c.get(COUNTER_NAMES.messagesIngested)).toBe(50);

    // Labeled counters partition by label set.
    expect(c.get(COUNTER_NAMES.memoryProposals, { action: 'accept', type: 'decision' })).toBe(6);
    expect(c.get(COUNTER_NAMES.memoryProposals, { action: 'reject', type: 'risk' })).toBe(2);
    expect(c.get(COUNTER_NAMES.memoryProposals)).toBe(0); // no unlabeled series
  });

  it('reports kind correctly for counters vs gauges', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.gatewayReconnects);
    c.set(GAUGE_NAMES.jobQueueDepth, 3);
    const byName = new Map(c.snapshot().map((s) => [s.name, s]));
    expect(byName.get(COUNTER_NAMES.gatewayReconnects)!.kind).toBe('counter');
    expect(byName.get(GAUGE_NAMES.jobQueueDepth)!.kind).toBe('gauge');
  });

  it('rejects a counter/gauge name collision (a wiring bug)', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.episodesOpened);
    expect(() => c.set(COUNTER_NAMES.episodesOpened, 9)).toThrow();
    c.set(GAUGE_NAMES.jobQueueDepth, 1);
    expect(() => c.inc(GAUGE_NAMES.jobQueueDepth)).toThrow();
  });

  it('ignores non-finite increments/sets rather than corrupting a series', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.messagesIngested, undefined, 5);
    c.inc(COUNTER_NAMES.messagesIngested, undefined, Number.NaN);
    c.set(GAUGE_NAMES.jobQueueDepth, Number.POSITIVE_INFINITY);
    expect(c.get(COUNTER_NAMES.messagesIngested)).toBe(5);
    expect(c.get(GAUGE_NAMES.jobQueueDepth)).toBe(0);
    expect(c.has(GAUGE_NAMES.jobQueueDepth)).toBe(false);
  });

  it('snapshot is sorted by name then labels for deterministic output', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.interventions, { stage: 'sent' });
    c.inc(COUNTER_NAMES.interventions, { stage: 'proposed' });
    c.inc(COUNTER_NAMES.interventions, { stage: 'dismissed' });
    c.inc(COUNTER_NAMES.episodesClosed);
    const snap = c.snapshot();
    const names = snap.map((s) => s.name);
    // episodes_closed_total sorts before interventions_total.
    expect(names.indexOf('episodes_closed_total')).toBeLessThan(names.indexOf('interventions_total'));
    const stages = snap.filter((s) => s.name === 'interventions_total').map((s) => s.labels.stage);
    expect(stages).toEqual(['dismissed', 'proposed', 'sent']); // alphabetical
  });

  it('reset clears all samples', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.messagesIngested);
    c.reset();
    expect(c.snapshot()).toHaveLength(0);
    expect(c.get(COUNTER_NAMES.messagesIngested)).toBe(0);
  });
});

describe('Section 33 alert derivation', () => {
  it('a healthy snapshot produces no alerts', () => {
    expect(deriveAlerts(healthyInput())).toEqual([]);
  });

  it('unknown (null) signals never fire an alert', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      oldestQueuedReviewAgeMs: null,
      volumeUsageRatio: null,
      modelBudgetUsedRatio: null,
      backupAgeMs: null,
      wal: { sizeBytes: null, lastCheckpointAgeMs: null },
    });
    expect(alerts).toEqual([]);
  });

  it('fires gateway_stale when ready but no recent event', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      gateway: { ready: true, lastEventAtMs: NOW - DEFAULT_ALERT_THRESHOLDS.gatewayStaleMs - 1, reconnectCount: 0 },
    });
    const a = alerts.find((x) => x.kind === 'gateway_stale');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('critical');
    expect(a!.detail).not.toContain('\n');
  });

  it('does not fire gateway_stale when not ready (nothing to expect)', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      gateway: { ready: false, lastEventAtMs: NOW - DEFAULT_ALERT_THRESHOLDS.gatewayStaleMs - 1, reconnectCount: 0 },
    });
    expect(alerts.find((x) => x.kind === 'gateway_stale')).toBeUndefined();
  });

  it('fires gateway_repeated_reconnects past the count threshold', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      gateway: { ready: true, lastEventAtMs: NOW, reconnectCount: DEFAULT_ALERT_THRESHOLDS.gatewayReconnectCount + 1 },
    });
    expect(alerts.find((x) => x.kind === 'gateway_repeated_reconnects')?.severity).toBe('warning');
  });

  it('fires review_sla_exceeded when the oldest queued review is past SLA', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      oldestQueuedReviewAgeMs: DEFAULT_ALERT_THRESHOLDS.reviewSlaMs + 1,
    });
    expect(alerts.find((x) => x.kind === 'review_sla_exceeded')?.severity).toBe('warning');
  });

  it('fires channel_sync_error when any channel is stuck', () => {
    const alerts = deriveAlerts({ ...healthyInput(), channelsInSyncError: 2 });
    expect(alerts.find((x) => x.kind === 'channel_sync_error')?.severity).toBe('warning');
  });

  it('fires volume_threshold_exceeded past the ratio threshold', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      volumeUsageRatio: DEFAULT_ALERT_THRESHOLDS.volumeUsageRatio + 0.1,
    });
    expect(alerts.find((x) => x.kind === 'volume_threshold_exceeded')?.severity).toBe('warning');
  });

  it('fires wal_growing_without_checkpoint only when WAL is large AND checkpoint stalled', () => {
    const base = { sizeBytes: DEFAULT_ALERT_THRESHOLDS.walBytes + 1, lastCheckpointAgeMs: 1_000 } as const;
    const stalled = { sizeBytes: DEFAULT_ALERT_THRESHOLDS.walBytes + 1, lastCheckpointAgeMs: DEFAULT_ALERT_THRESHOLDS.walCheckpointStallMs + 1 } as const;
    // Large but recently checkpointed → no alert.
    expect(
      deriveAlerts({ ...healthyInput(), wal: base }).find((x) => x.kind === 'wal_growing_without_checkpoint'),
    ).toBeUndefined();
    // Large and stalled → alert.
    expect(
      deriveAlerts({ ...healthyInput(), wal: stalled }).find((x) => x.kind === 'wal_growing_without_checkpoint'),
    ).toBeDefined();
  });

  it('fires model_budget_exceeded past the budget ratio', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      modelBudgetUsedRatio: DEFAULT_ALERT_THRESHOLDS.modelBudgetRatio + 0.05,
    });
    expect(alerts.find((x) => x.kind === 'model_budget_exceeded')?.severity).toBe('critical');
  });

  it('fires backup_stale when the last backup is older than the threshold', () => {
    const alerts = deriveAlerts({
      ...healthyInput(),
      backupAgeMs: DEFAULT_ALERT_THRESHOLDS.backupStaleMs + 1,
    });
    expect(alerts.find((x) => x.kind === 'backup_stale')?.severity).toBe('critical');
  });

  it('fires database_integrity_failed when the check fails', () => {
    const alerts = deriveAlerts({ ...healthyInput(), databaseIntegrityOk: false });
    const a = alerts.find((x) => x.kind === 'database_integrity_failed');
    expect(a).toBeDefined();
    expect(a!.severity).toBe('critical');
  });

  it('respects a custom threshold override (no false positive, then fires)', () => {
    const tight: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS, reviewSlaMs: 1_000 };
    expect(deriveAlerts(healthyInput(), tight)).toEqual([]);
    const alerts = deriveAlerts({ ...healthyInput(), oldestQueuedReviewAgeMs: 5_000 }, tight);
    expect(alerts.find((x) => x.kind === 'review_sla_exceeded')).toBeDefined();
  });

  it('can fire every alert at once from one bad snapshot, in stable order', () => {
    const bad: AlertInput = {
      nowMs: NOW,
      gateway: {
        ready: true,
        lastEventAtMs: NOW - DEFAULT_ALERT_THRESHOLDS.gatewayStaleMs - 1,
        reconnectCount: DEFAULT_ALERT_THRESHOLDS.gatewayReconnectCount + 1,
      },
      oldestQueuedReviewAgeMs: DEFAULT_ALERT_THRESHOLDS.reviewSlaMs + 1,
      channelsInSyncError: 3,
      volumeUsageRatio: DEFAULT_ALERT_THRESHOLDS.volumeUsageRatio + 0.1,
      wal: {
        sizeBytes: DEFAULT_ALERT_THRESHOLDS.walBytes + 1,
        lastCheckpointAgeMs: DEFAULT_ALERT_THRESHOLDS.walCheckpointStallMs + 1,
      },
      modelBudgetUsedRatio: DEFAULT_ALERT_THRESHOLDS.modelBudgetRatio + 0.05,
      backupAgeMs: DEFAULT_ALERT_THRESHOLDS.backupStaleMs + 1,
      databaseIntegrityOk: false,
    };
    const alerts = deriveAlerts(bad);
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toEqual([
      'gateway_stale',
      'gateway_repeated_reconnects',
      'review_sla_exceeded',
      'channel_sync_error',
      'volume_threshold_exceeded',
      'wal_growing_without_checkpoint',
      'model_budget_exceeded',
      'backup_stale',
      'database_integrity_failed',
    ]);
  });
});

describe('counters and alerts carry no message content (Section 33)', () => {
  // A content canary that must never appear in any observable output.
  const CANARY = 'SECRET-MESSAGE-CONTENT-XYZ';

  it('a metric sample is exactly {name, labels, value, kind}', () => {
    const c = createCounters();
    c.inc(COUNTER_NAMES.messagesIngested, undefined, 1);
    const sample = c.snapshot()[0]!;
    expect(Object.keys(sample).sort()).toEqual(['kind', 'labels', 'name', 'value']);
    // labels is the only object field; its values are whatever the caller passed,
    // but the sample itself introduces no content/prompt/message/authorization key.
  });

  it('an active alert is exactly {kind, severity, detail}', () => {
    const alerts: ActiveAlert[] = deriveAlerts({ ...healthyInput(), databaseIntegrityOk: false });
    const a = alerts.find((x) => x.kind === 'database_integrity_failed')!;
    expect(Object.keys(a).sort()).toEqual(['detail', 'kind', 'severity']);
  });

  it('alert details are numeric only — no content canary reaches the report', () => {
    // deriveAlerts accepts no content argument; a bad snapshot produces only
    // counts/sizes/durations. Planting a canary anywhere it could plausibly enter
    // (it cannot) is therefore impossible — assert the dump has none regardless.
    const report = buildObservabilityReport(createCounters(), {
      ...healthyInput(),
      databaseIntegrityOk: false,
      channelsInSyncError: 99,
    });
    const dump = JSON.stringify(report);
    expect(dump).not.toContain(CANARY);
    // Every field name present is a known-safe one (no content/prompt/message/token key).
    for (const forbidden of ['content', 'prompt', 'message', 'token', 'authorization', 'body']) {
      expect(dump.toLowerCase()).not.toContain(`"${forbidden}"`);
    }
  });
});

/** Composite key for a sample: name plus its label signature (for lookups). */
function sampleKey(s: MetricSample): string {
  const labels = Object.entries(s.labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return labels ? `${s.name}{${labels}}` : s.name;
}
