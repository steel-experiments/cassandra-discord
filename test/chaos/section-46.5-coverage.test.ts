import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Section 46.5 chaos-suite coverage registry (task T120).
 *
 * Each of the eight Section 46.5 chaos cases is mapped to the real test file
 * that proves its recovery verdict, plus a verbatim needle that must appear in
 * that file. This self-validates that no case is silently missing: if a test is
 * renamed or deleted, the matching needle disappears and this registry fails.
 *
 * Cases 2, 3, and 8 are covered by their existing dedicated suites; the
 * remaining cases live in this `test/chaos/` directory. Every case documents a
 * recovery verdict with no privacy leak or silent corruption (see README.md).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));

interface Scenario {
  case: string;
  title: string;
  /** Path to the test file (relative to repo root) that owns the verdict. */
  file: string;
  /** A string that must literally appear in that file. */
  needle: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    case: '46.5-1',
    title: 'kill the process during a page insert',
    file: 'test/chaos/crash-recovery.test.ts',
    needle: 'rolls back the whole page when a write fails midway',
  },
  {
    case: '46.5-2',
    title: 'kill during a model call',
    file: 'test/integration/episode-review.test.ts',
    needle: 'marks error and never throws when the executor itself throws',
  },
  {
    case: '46.5-3',
    title: 'kill after Discord send but before outbox update',
    file: 'test/integration/outbox-crash-recovery.test.ts',
    needle: 'records the existing Discord id, marks the row sent',
  },
  {
    case: '46.5-4',
    title: 'disconnect the network',
    file: 'test/chaos/infrastructure-faults.test.ts',
    needle: 'classifies a raw connection failure as transient',
  },
  {
    case: '46.5-5',
    title: 'corrupt a job lease',
    file: 'test/chaos/infrastructure-faults.test.ts',
    needle: 'reclaims an expired lease and re-runs the job exactly once',
  },
  {
    case: '46.5-6',
    title: 'fill disk in a test environment',
    file: 'test/chaos/crash-recovery.test.ts',
    needle: 'rolls back the whole transaction when a write fails (modelled SQLITE_FULL)',
  },
  {
    case: '46.5-7',
    title: 'restore from backup',
    file: 'test/chaos/backup-migration.test.ts',
    needle: 'restores a standalone snapshot',
  },
  {
    case: '46.5-8',
    title: 'deploy a schema migration and roll back application code',
    file: 'test/unit/migrations.test.ts',
    needle: 'is idempotent on repeated runs (applies nothing new)',
  },
];

describe('Section 46.5 chaos coverage registry', () => {
  it('covers every documented chaos case exactly once', () => {
    expect(SCENARIOS).toHaveLength(8);
    const cases = new Set(SCENARIOS.map((s) => s.case));
    expect(cases).toEqual(new Set(['46.5-1', '46.5-2', '46.5-3', '46.5-4', '46.5-5', '46.5-6', '46.5-7', '46.5-8']));
  });

  it.each(SCENARIOS)(
    '$case — "$title" — is backed by a test whose needle is present',
    ({ file, needle }) => {
      const contents = readFileSync(`${root}${file}`, 'utf8');
      expect(contents).toContain(needle);
    },
  );
});
