import type { DatabaseSync } from '../../db/database.js';
import {
  createBackup,
  rotateBackups,
  type CreateBackupResult,
  type RotateBackupsResult,
} from '../../db/backup.js';
import { APP_VERSION } from '../../version.js';
import type { Logger } from '../../logger.js';
import type { JobHandler } from '../worker.js';

/**
 * `backup_database` job handler (Sections 10, 42.1). Periodic standalone backup
 * of the live database through the SQLite online backup API, followed by local
 * retention rotation. The handler runs outside any transaction (the backup API
 * manages its own reads); the live connection may keep receiving writes while
 * the snapshot is taken.
 */

export interface BackupDatabaseHandlerDeps {
  db: DatabaseSync;
  /** Directory backups are written under (typically `DATA_DIR/backups`). */
  backupsDir: string;
  /** Absolute path of the live source database (recorded in the manifest). */
  sourceDatabasePath: string;
  /** Override the recorded application version (default: `APP_VERSION`). */
  appVersion?: string;
  /** Inject a clock for deterministic tests (default `Date.now`). */
  now?: () => number;
  /**
   * Backups older than this many days are removed after each run. Default 0
   * (retain all); the application wires `BACKUP_RETENTION_DAYS` here.
   */
  retentionDays?: number;
  logger?: Pick<Logger, 'info' | 'warn'>;
  /** Best-effort private notification after a verified backup succeeds. */
  notifyCompleted?: (notice: {
    requesterUserId: string;
    file: string;
    bytes: number;
    timestampMs: number;
  }) => Promise<void>;
}

export interface BackupDatabaseHandlerResult {
  result: CreateBackupResult;
  rotation: RotateBackupsResult;
}

/**
 * Build a `backup_database` job handler. `runBackup()` performs the same work
 * (create + rotate) awaitable for callers and tests.
 */
export function createBackupDatabaseHandler(
  deps: BackupDatabaseHandlerDeps,
): JobHandler<'backup_database'> & {
  runBackup(): Promise<BackupDatabaseHandlerResult>;
} {
  const run = async (): Promise<BackupDatabaseHandlerResult> => {
    const now = deps.now?.() ?? Date.now();
    const result = await createBackup({
      db: deps.db,
      backupsDir: deps.backupsDir,
      sourceDatabasePath: deps.sourceDatabasePath,
      appVersion: deps.appVersion ?? APP_VERSION,
      now,
    });
    // Section 42.1 step 5: rotate local backups after each creation.
    const rotation = rotateBackups({
      backupsDir: deps.backupsDir,
      retentionDays: deps.retentionDays ?? 0,
      now,
    });
    return { result, rotation };
  };

  const handler: JobHandler<'backup_database'> = async (payload, job): Promise<void> => {
    const startedAtMs = Date.now();
    deps.logger?.info({
      event: 'backup.started',
      jobId: job.id,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
    }, 'online backup started');

    try {
      const { result, rotation } = await run();
      deps.logger?.info({
        event: 'backup.succeeded',
        jobId: job.id,
        attempt: job.attempts,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        file: result.manifest.file,
        bytes: result.manifest.bytes,
        pages: result.pages,
        integrityCheck: result.manifest.integrityCheck,
        retained: rotation.retained,
        deleted: rotation.deleted,
      }, 'online backup completed');

      if (payload.requesterUserId && deps.notifyCompleted) {
        try {
          await deps.notifyCompleted({
            requesterUserId: payload.requesterUserId,
            file: result.manifest.file,
            bytes: result.manifest.bytes,
            timestampMs: result.manifest.timestampMs,
          });
          deps.logger?.info({ event: 'backup.notification_sent', jobId: job.id }, 'backup completion notification sent');
        } catch (err) {
          // The backup is already valid. A Discord failure must not retry it and
          // create another snapshot merely to redeliver an operator notice.
          deps.logger?.warn({
            event: 'backup.notification_failed',
            jobId: job.id,
            err: err instanceof Error ? err.message : String(err),
          }, 'backup completed but private notification failed');
        }
      }
    } catch (err) {
      deps.logger?.warn({
        event: 'backup.failed',
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        err: err instanceof Error ? err.message : String(err),
      }, 'online backup attempt failed');
      throw err;
    }
  };

  return Object.assign(handler, {
    runBackup: run,
  });
}
