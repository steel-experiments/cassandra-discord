import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';
import { randomUUID } from 'node:crypto';
import { enqueue } from '../../jobs/queue.js';

/**
 * Attachment metadata and archive-state persistence (Section 9.10, 29.1).
 *
 * Metadata is written idempotently on every message that carries attachments.
 * Archive state (local_path, sha256, archive_status) is mutated separately by
 * the attachment layer after a file is downloaded outside any transaction.
 */

export interface AttachmentUpsertInput {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
  proxyUrl: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  source_url: string | null;
  proxy_url: string | null;
  archive_status: string;
  local_path: string | null;
  sha256: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

const UPSERT_SQL = `
  INSERT INTO attachments (
    id, message_id, filename, mime_type, size_bytes, width, height,
    source_url, proxy_url, archive_status, local_path, sha256,
    created_at_ms, updated_at_ms
  ) VALUES (
    @id, @message_id, @filename, @mime_type, @size_bytes, @width, @height,
    @source_url, @proxy_url, 'metadata', NULL, NULL, @created_at_ms, @updated_at_ms
  )
  ON CONFLICT(id) DO UPDATE SET
    filename = excluded.filename,
    mime_type = excluded.mime_type,
    size_bytes = excluded.size_bytes,
    width = excluded.width,
    height = excluded.height,
    source_url = excluded.source_url,
    proxy_url = excluded.proxy_url,
    updated_at_ms = CASE
      WHEN excluded.filename IS NOT attachments.filename
        OR excluded.mime_type IS NOT attachments.mime_type
        OR excluded.size_bytes IS NOT attachments.size_bytes
        OR excluded.width IS NOT attachments.width
        OR excluded.height IS NOT attachments.height
        OR excluded.source_url IS NOT attachments.source_url
        OR excluded.proxy_url IS NOT attachments.proxy_url
      THEN excluded.updated_at_ms
      ELSE attachments.updated_at_ms
    END
  WHERE excluded.filename IS NOT attachments.filename
     OR excluded.mime_type IS NOT attachments.mime_type
     OR excluded.size_bytes IS NOT attachments.size_bytes
     OR excluded.width IS NOT attachments.width
     OR excluded.height IS NOT attachments.height
     OR excluded.source_url IS NOT attachments.source_url
     OR excluded.proxy_url IS NOT attachments.proxy_url
`;

/**
 * Persist metadata for a set of attachments (idempotent on attachment id).
 * Returns total rows changed.
 */
export function upsertAttachments(db: DatabaseSync, items: AttachmentUpsertInput[]): number {
  const stmt = prepareCached(db, 'attachments.upsert', UPSERT_SQL);
  let changed = 0;
  for (const a of items) {
    changed += Number(
      stmt.run({
        id: a.id,
        message_id: a.messageId,
        filename: a.filename,
        mime_type: a.mimeType,
        size_bytes: a.sizeBytes,
        width: a.width,
        height: a.height,
        source_url: a.sourceUrl,
        proxy_url: a.proxyUrl,
        created_at_ms: a.createdAtMs,
        updated_at_ms: a.updatedAtMs,
      }).changes,
    );
  }
  return changed;
}

export function getAttachment(db: DatabaseSync, id: string): AttachmentRow | undefined {
  return prepareCached(db, 'attachments.get', 'SELECT * FROM attachments WHERE id = ?').get(id) as
    | AttachmentRow
    | undefined;
}

export interface ArchiveUpdate {
  id: string;
  localPath: string | null;
  sha256: string | null;
  /** One of: queued, stored, failed, metadata, none, deleted. */
  status: string;
  updatedAtMs: number;
}

const SET_ARCHIVE_SQL = `
  UPDATE attachments
     SET local_path = @local_path,
         sha256 = @sha256,
         archive_status = @status,
         updated_at_ms = @updated_at_ms
   WHERE id = @id AND archive_status <> 'deleted'
     AND EXISTS (
       SELECT 1 FROM messages m
        WHERE m.id = attachments.message_id AND m.deleted_at_ms IS NULL
     )
`;

/** Record the outcome of an archive attempt (called after the download). */
export function setAttachmentArchive(db: DatabaseSync, update: ArchiveUpdate): number {
  return Number(
    prepareCached(db, 'attachments.set_archive', SET_ARCHIVE_SQL).run({
      id: update.id,
      local_path: update.localPath,
      sha256: update.sha256,
      status: update.status,
      updated_at_ms: update.updatedAtMs,
    }).changes,
  );
}

/**
 * Return the local archive paths for a message's attachments, for filesystem
 * cleanup after a delete.
 */
export function listAttachmentLocalPaths(db: DatabaseSync, messageId: string): string[] {
  const rows = prepareCached(
    db,
    'attachments.local_paths',
    'SELECT local_path FROM attachments WHERE message_id = ? AND local_path IS NOT NULL',
  ).all(messageId) as Array<{ local_path: string }>;
  return rows.map((r) => r.local_path);
}

/**
 * Mark a message's attachments as deleted and drop their local_path/sha256.
 * Called after the files are removed from disk. Returns rows changed.
 */
export function markAttachmentsDeleted(db: DatabaseSync, messageId: string, nowMs: number): number {
  const archived = prepareCached(
    db,
    'attachments.paths_for_purge',
    'SELECT id, local_path FROM attachments WHERE message_id = ? AND local_path IS NOT NULL',
  ).all(messageId) as Array<{ id: string; local_path: string }>;
  for (const row of archived) {
    const purgeId = randomUUID();
    const inserted = Number(prepareCached(
      db,
      'attachments.enqueue_file_purge',
      `INSERT INTO attachment_file_purges
         (id, attachment_id, local_path, status, attempts, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'queued', 0, ?, ?)
       ON CONFLICT(local_path) DO NOTHING`,
    ).run(purgeId, row.id, row.local_path, nowMs, nowMs).changes);
    if (inserted > 0) {
      enqueue(db, {
        type: 'purge_attachment_file', payload: { purgeId },
        uniqueKey: `attachment:purge:${purgeId}`, now: nowMs,
      });
    }
  }
  return Number(
    prepareCached(
      db,
      'attachments.mark_deleted',
      "UPDATE attachments SET archive_status = 'deleted', local_path = NULL, sha256 = NULL, updated_at_ms = ? WHERE message_id = ? AND archive_status NOT IN ('deleted', 'none')",
    ).run(nowMs, messageId).changes,
  );
}

export interface AttachmentFilePurgeRow {
  id: string;
  attachment_id: string | null;
  local_path: string;
  status: 'queued' | 'purged' | 'failed';
  attempts: number;
}

export function getAttachmentFilePurge(db: DatabaseSync, id: string): AttachmentFilePurgeRow | undefined {
  return prepareCached(db, 'attachments.get_file_purge', 'SELECT * FROM attachment_file_purges WHERE id = ?')
    .get(id) as AttachmentFilePurgeRow | undefined;
}

export function markAttachmentFilePurged(db: DatabaseSync, id: string, nowMs: number): void {
  prepareCached(db, 'attachments.file_purged', `UPDATE attachment_file_purges
    SET status='purged', purged_at_ms=?, updated_at_ms=?, last_error=NULL WHERE id=?`).run(nowMs, nowMs, id);
}

export function markAttachmentFilePurgeFailed(db: DatabaseSync, id: string, error: string, nowMs: number): void {
  prepareCached(db, 'attachments.file_purge_failed', `UPDATE attachment_file_purges
    SET status='failed', attempts=attempts+1, last_error=?, updated_at_ms=? WHERE id=?`)
    .run(error.slice(0, 4000), nowMs, id);
}
