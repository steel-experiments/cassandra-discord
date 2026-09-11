import { type DatabaseSync } from '../database.js';
import { prepareCached, toInt } from './util.js';

/**
 * Per-channel sync cursors (Section 9.5, 9.6).
 *
 * `sync_cursors` is the durable record of how far a channel's history has been
 * ingested. Backfill reads `next_before_message_id` to resume without gaps or
 * duplicate rows, and flips `history_complete` to 1 only at the true end of
 * history. Reconciliation after downtime uses the same row.
 */

export type SyncState = 'pending' | 'backfilling' | 'live' | 'error' | 'excluded';

export interface SyncCursorRow {
  channelId: string;
  state: SyncState;
  historyComplete: boolean;
  oldestMessageId: string | null;
  newestMessageId: string | null;
  oldestCreatedAtMs: number | null;
  newestCreatedAtMs: number | null;
  nextBeforeMessageId: string | null;
  reconcileBeforeMessageId: string | null;
  reconcileScanStartedAtMs: number | null;
  reconcileLowerBoundMs: number | null;
  reconcileHeadMessageId: string | null;
  lastCompletedReconcileScanStartedAtMs: number | null;
  lastReconciledAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  retryCount: number;
  updatedAtMs: number;
}

const SELECT_COLS = `
  channel_id AS channelId,
  state,
  history_complete AS historyComplete,
  oldest_message_id AS oldestMessageId,
  newest_message_id AS newestMessageId,
  oldest_created_at_ms AS oldestCreatedAtMs,
  newest_created_at_ms AS newestCreatedAtMs,
  next_before_message_id AS nextBeforeMessageId,
  reconcile_before_message_id AS reconcileBeforeMessageId,
  reconcile_scan_started_at_ms AS reconcileScanStartedAtMs,
  reconcile_lower_bound_ms AS reconcileLowerBoundMs,
  reconcile_head_message_id AS reconcileHeadMessageId,
  last_completed_reconcile_scan_started_at_ms AS lastCompletedReconcileScanStartedAtMs,
  last_reconciled_at_ms AS lastReconciledAtMs,
  last_success_at_ms AS lastSuccessAtMs,
  last_error AS lastError,
  retry_count AS retryCount,
  updated_at_ms AS updatedAtMs
`;

/** Read a channel's sync cursor, or null when none exists yet. */
export function getSyncCursor(db: DatabaseSync, channelId: string): SyncCursorRow | null {
  const row = prepareCached(db, 'sync-cursors.get', `SELECT ${SELECT_COLS} FROM sync_cursors WHERE channel_id = ?`).get(
    channelId,
  ) as (Omit<SyncCursorRow, 'historyComplete'> & { historyComplete: number }) | undefined;
  if (!row) return null;
  return { ...row, historyComplete: row.historyComplete === 1 };
}

/** Insert a pending cursor if none exists. Idempotent; preserves an existing row. */
export function ensureSyncCursor(db: DatabaseSync, channelId: string, now: number): void {
  prepareCached(
    db,
    'sync-cursors.ensure',
    `INSERT OR IGNORE INTO sync_cursors (channel_id, state, history_complete, retry_count, updated_at_ms)
     VALUES (?, 'pending', 0, 0, ?)`,
  ).run(channelId, now);
}

export interface BackfillPageBounds {
  /** Oldest message id in this page (becomes the next `before`). */
  oldestMessageId: string;
  oldestCreatedAtMs: number;
  /** Newest message id in this page; recorded only when not already known. */
  newestMessageId?: string;
  newestCreatedAtMs?: number;
}

/**
 * Record progress after a backfill page: advance `next_before_message_id` to the
 * page's oldest message, widen the bounds, and mark the channel `backfilling`.
 * The newest bound is set only when it is currently null (the first page of a
 * fresh backfill), so a resumed run never overwrites the true newest with an
 * older-than-cursor message.
 */
export function recordBackfillPage(
  db: DatabaseSync,
  channelId: string,
  bounds: BackfillPageBounds,
  now: number,
): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(
    db,
    'sync-cursors.page',
    `UPDATE sync_cursors SET
       state = 'backfilling',
       history_complete = 0,
       next_before_message_id = @nextBeforeMessageId,
       oldest_message_id = @oldestMessageId,
       oldest_created_at_ms = @oldestCreatedAtMs,
       newest_message_id = COALESCE(newest_message_id, @newestMessageId),
       newest_created_at_ms = COALESCE(newest_created_at_ms, @newestCreatedAtMs),
       last_error = NULL,
       updated_at_ms = @updatedAtMs
     WHERE channel_id = @channelId`,
  ).run({
    channelId,
    nextBeforeMessageId: bounds.oldestMessageId,
    oldestMessageId: bounds.oldestMessageId,
    oldestCreatedAtMs: bounds.oldestCreatedAtMs,
    newestMessageId: bounds.newestMessageId ?? null,
    newestCreatedAtMs: bounds.newestCreatedAtMs ?? null,
    updatedAtMs: now,
  });
}

/**
 * Mark a channel's history fully ingested: state `live`, history_complete 1, and
 * the final bounds recorded. Called only when backfill reaches the actual end.
 */
export function markBackfillComplete(
  db: DatabaseSync,
  channelId: string,
  bounds: { oldestMessageId?: string | null; newestMessageId?: string | null; oldestCreatedAtMs?: number | null; newestCreatedAtMs?: number | null },
  now: number,
): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(
    db,
    'sync-cursors.complete',
    `UPDATE sync_cursors SET
       state = 'live',
       history_complete = 1,
       oldest_message_id = COALESCE(@oldestMessageId, oldest_message_id),
       newest_message_id = COALESCE(@newestMessageId, newest_message_id),
       oldest_created_at_ms = COALESCE(@oldestCreatedAtMs, oldest_created_at_ms),
       newest_created_at_ms = COALESCE(@newestCreatedAtMs, newest_created_at_ms),
       next_before_message_id = NULL,
       last_success_at_ms = @now,
       last_error = NULL,
       updated_at_ms = @now
     WHERE channel_id = @channelId`,
  ).run({
    channelId,
    oldestMessageId: bounds.oldestMessageId ?? null,
    newestMessageId: bounds.newestMessageId ?? null,
    oldestCreatedAtMs: bounds.oldestCreatedAtMs ?? null,
    newestCreatedAtMs: bounds.newestCreatedAtMs ?? null,
    now,
  });
}

/** Record a backfill failure without losing the durable cursor; state `error`. */
export function markBackfillError(db: DatabaseSync, channelId: string, error: string, now: number): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(
    db,
    'sync-cursors.error',
    `UPDATE sync_cursors SET
       state = 'error',
       last_error = @error,
       retry_count = retry_count + 1,
       updated_at_ms = @now
     WHERE channel_id = @channelId`,
  ).run({ channelId, error, now });
}

/** Mark a channel excluded from ingestion entirely. */
export function markExcluded(db: DatabaseSync, channelId: string, now: number): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(
    db,
    'sync-cursors.excluded',
    `UPDATE sync_cursors SET state = 'excluded', updated_at_ms = ? WHERE channel_id = ?`,
  ).run(now, channelId);
}

export interface ReconcileBounds {
  /** Newest message id seen during reconciliation (bumps the bound only if newer). */
  newestMessageId?: string;
  newestCreatedAtMs?: number;
}

/** Save the next reconciliation page before a bounded pass exits. */
export function recordReconcileProgress(
  db: DatabaseSync,
  channelId: string,
  beforeMessageId: string,
  now: number,
): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(db, 'sync-cursors.reconcile-progress', `
    UPDATE sync_cursors SET reconcile_before_message_id=?, updated_at_ms=?
    WHERE channel_id=?`).run(beforeMessageId, now, channelId);
}

export function beginReconcileScan(
  db: DatabaseSync, channelId: string,
  scanStartedAtMs: number, lowerBoundMs: number, headMessageId: string | null, now: number,
): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(db, 'sync-cursors.reconcile-begin', `UPDATE sync_cursors SET
    reconcile_scan_started_at_ms=?, reconcile_lower_bound_ms=?, reconcile_head_message_id=?,
    reconcile_before_message_id=NULL, updated_at_ms=? WHERE channel_id=?`)
    .run(scanStartedAtMs, lowerBoundMs, headMessageId, now, channelId);
}

export function recordReconcileScanProgress(
  db: DatabaseSync, channelId: string, beforeMessageId: string, headMessageId: string | null, now: number,
): void {
  prepareCached(db, 'sync-cursors.reconcile-scan-progress', `UPDATE sync_cursors SET
    reconcile_before_message_id=?, reconcile_head_message_id=COALESCE(reconcile_head_message_id, ?),
    updated_at_ms=? WHERE channel_id=?`).run(beforeMessageId, headMessageId, now, channelId);
}

export function completeReconcileScan(
  db: DatabaseSync, channelId: string, scanStartedAtMs: number, headMessageId: string | null, now: number,
): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(db, 'sync-cursors.reconcile-scan-complete', `UPDATE sync_cursors SET
    state='live', reconcile_before_message_id=NULL, reconcile_scan_started_at_ms=NULL,
    reconcile_lower_bound_ms=NULL, reconcile_head_message_id=NULL,
    last_completed_reconcile_scan_started_at_ms=?, last_reconciled_at_ms=?, last_success_at_ms=?,
    newest_message_id=COALESCE(?, newest_message_id), last_error=NULL, updated_at_ms=?
    WHERE channel_id=?`).run(scanStartedAtMs, now, now, headMessageId, now, channelId);
}

/**
 * Record a successful reconciliation pass (Section 9.6 step 5). Updates
 * `last_reconciled_at_ms` and `last_success_at_ms`, and bumps the newest bound when
 * the pass observed a message newer than the stored one. Does not touch backfill
 * state or history_complete — reconciliation only fills gaps, never infers deletes.
 */
export function markReconciled(db: DatabaseSync, channelId: string, bounds: ReconcileBounds, now: number): void {
  ensureSyncCursor(db, channelId, now);
  prepareCached(
    db,
    'sync-cursors.reconciled',
    `UPDATE sync_cursors SET
       last_reconciled_at_ms = @now,
       last_success_at_ms = @now,
       reconcile_before_message_id = NULL,
       newest_message_id = CASE
         WHEN @newestMessageId IS NOT NULL
              AND (newest_message_id IS NULL OR @newestMessageId > newest_message_id)
         THEN @newestMessageId ELSE newest_message_id END,
       newest_created_at_ms = CASE
         WHEN @newestCreatedAtMs IS NOT NULL
              AND (newest_created_at_ms IS NULL OR @newestCreatedAtMs > newest_created_at_ms)
         THEN @newestCreatedAtMs ELSE newest_created_at_ms END,
       updated_at_ms = @now
     WHERE channel_id = @channelId`,
  ).run({
    channelId,
    now,
    newestMessageId: bounds.newestMessageId ?? null,
    newestCreatedAtMs: bounds.newestCreatedAtMs ?? null,
  });
}

export { toInt };
