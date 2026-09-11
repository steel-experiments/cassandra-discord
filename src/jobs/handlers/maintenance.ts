import type { DatabaseSync } from '../../db/database.js';
import type { JobHandler } from '../worker.js';
import type { JobRow } from '../types.js';
import { runMaintenance, type MaintenanceOutcome, type RunMaintenanceOptions } from '../../db/maintenance.js';

/**
 * `maintenance` job handler — database integrity and optimization (Section 28).
 * The scheduler enqueues a periodic `maintenance` job (unique key
 * `schedule:maintenance`) at the `PRAGMA optimize` interval; this handler runs
 * the daily bundle: `PRAGMA optimize`, a passive WAL checkpoint, the bounded
 * prune of terminal job rows past `JOBS_RETENTION_DAYS` (Section 10), and —
 * when configured — an integrity probe and an opt-in `VACUUM` plus the
 * mandatory FTS rebuild that must follow it.
 *
 * Like every job handler it runs OUTSIDE any transaction (Section 10): the
 * worker claims the job in one short transaction, the handler runs (here, a
 * handful of PRAGMA statements), and a second short transaction records the
 * outcome. `VACUUM` itself cannot be transactional, so it is run directly.
 *
 * Maintenance never copies the live `.sqlite` file (Section 28). The handler is
 * a thin wrapper over {@link runMaintenance}; an optional `onOutcome` hook lets
 * the runtime log the reported outcomes for observability.
 */

export interface DatabaseMaintenanceHandlerDeps {
  db: DatabaseSync;
  /**
   * Options forwarded to {@link runMaintenance}. The periodic default is a
   * `PASSIVE` checkpoint plus `PRAGMA optimize` with no integrity probe and no
   * VACUUM; callers wire `integrity`/`vacuum`/`checkpointMode` to widen a run.
   */
  options?: Omit<RunMaintenanceOptions, 'pruneJobs'>;
  /**
   * Retention for terminal job rows in days (`JOBS_RETENTION_DAYS`). Absent,
   * no rows are pruned — the production wiring always sets it.
   */
  jobsRetentionDays?: number;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /** Observability hook receiving the reported outcome and wall-clock time. */
  onOutcome?: (outcome: MaintenanceOutcome, nowMs: number) => void;
}

export interface DatabaseMaintenanceHandlerResult {
  outcome: MaintenanceOutcome;
}

/**
 * Build a `maintenance` job handler that runs the database maintenance bundle
 * and reports outcomes. `runDatabaseMaintenance()` performs the same work
 * awaitable for callers and tests.
 */
export function createDatabaseMaintenanceHandler(
  deps: DatabaseMaintenanceHandlerDeps,
): JobHandler<'maintenance'> & {
  /** Run the maintenance bundle and resolve with the reported outcome. */
  runDatabaseMaintenance(): Promise<DatabaseMaintenanceHandlerResult>;
} {
  const runOnce = (): MaintenanceOutcome => {
    const nowMs = (deps.now ?? Date.now)();
    const options: RunMaintenanceOptions = { ...deps.options };
    if (deps.jobsRetentionDays !== undefined) {
      options.pruneJobs = { nowMs, retentionDays: deps.jobsRetentionDays };
    }
    const outcome = runMaintenance(deps.db, options);
    deps.onOutcome?.(outcome, nowMs);
    return outcome;
  };

  const handler = async (_payload: Record<string, never>, _job: JobRow): Promise<void> => {
    runOnce();
  };

  return Object.assign(handler, {
    async runDatabaseMaintenance(): Promise<DatabaseMaintenanceHandlerResult> {
      return { outcome: runOnce() };
    },
  });
}
