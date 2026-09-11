import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Section 46.2 scenario-coverage registry (task T119).
 *
 * Acceptance: "Every Section 46.2 integration scenario has a deterministic
 * automated test." This file encodes that as an enforced invariant: each of the
 * 15 scenarios maps to a concrete test file plus a verbatim needle (a test or
 * describe title) that must be present on disk. If a test is deleted or renamed,
 * this registry fails and names the gap, instead of coverage silently drifting.
 *
 * This is deliberately a registry of *existing* tests, not a second copy of
 * them — the scenarios themselves are exercised in their own files.
 */

interface ScenarioCoverage {
  /** The Section 46.2 scenario, verbatim from the spec list. */
  scenario: string;
  /** Test file, relative to this directory. */
  file: string;
  /** A verbatim substring (test/describe title) that must appear in the file. */
  needle: string;
}

const SCENARIOS: readonly ScenarioCoverage[] = [
  {
    scenario: 'connect-live-before-backfill ordering',
    file: 'startup-order.test.ts',
    needle: 'begins live event storage before enqueuing any historical import',
  },
  {
    scenario: 'multi-page backfill',
    file: 'backfill.test.ts',
    needle: 'pages newest-to-oldest and marks history_complete only at the true end',
  },
  {
    scenario: 'restart in the middle of backfill',
    file: 'backfill.test.ts',
    needle: 'resumes from the durable cursor without gaps or duplicates',
  },
  {
    scenario: 'duplicate Gateway events',
    file: 'message-ingest.test.ts',
    needle: 'is a no-op on an identical re-delivery',
  },
  {
    scenario: 'message update and deletion',
    file: 'deletion.test.ts',
    needle: 'captures prior content as a version only when RETAIN_EDIT_HISTORY is on',
  },
  {
    scenario: 'bulk deletion',
    file: 'gateway-events.test.ts',
    needle: 'MESSAGE_DELETE_BULK tombstones a batch',
  },
  {
    scenario: 'active and archived thread discovery',
    file: 'thread-discovery.test.ts',
    needle: 'paginates public then private until hasMore is false',
  },
  {
    scenario: 'forum posts',
    file: 'thread-discovery.test.ts',
    needle: 'covers active, public archived, private archived, announcement, forum, and media threads',
  },
  {
    scenario: 'reaction add/remove',
    file: 'reactions.test.ts',
    needle: 'stores per-user rows and a recomputed live aggregate',
  },
  {
    scenario: 'rate-limit retry',
    file: 'ingestion-reliability.test.ts',
    needle: 'rate-limit retry on outbox delivery',
  },
  {
    scenario: 'model timeout',
    file: 'agent-runtime.test.ts',
    needle: 'fails closed on wall-clock timeout without sending anything',
  },
  {
    scenario: 'rejected final tool output',
    file: '../unit/finalize-tools.test.ts',
    needle: 'rejects a retargeted proposal once',
  },
  {
    scenario: 'outbox retry',
    file: 'outbox-send.test.ts',
    needle: 'transient failure retries safely',
  },
  {
    scenario: 'outbox sending-state crash recovery',
    file: 'outbox-crash-recovery.test.ts',
    needle: 'reconcileOutboxSending',
  },
  {
    scenario: 'graceful shutdown',
    file: 'shutdown.test.ts',
    needle: 'marks readiness down, runs every teardown stage, and closes the database',
  },
];

describe('Section 46.2 — every scenario has a deterministic automated test', () => {
  it('registers exactly the fifteen Section 46.2 scenarios', () => {
    expect(SCENARIOS).toHaveLength(15);
    const names = new Set(SCENARIOS.map((s) => s.scenario));
    expect(names.size).toBe(15);
  });

  for (const s of SCENARIOS) {
    it(`covers "${s.scenario}" in ${s.file}`, () => {
      const contents = readFileSync(new URL(s.file, import.meta.url), 'utf8');
      expect(
        contents.includes(s.needle),
        `Scenario "${s.scenario}" — needle not found in ${s.file}:\n  ${s.needle}`,
      ).toBe(true);
    });
  }
});
