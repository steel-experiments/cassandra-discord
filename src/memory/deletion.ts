import { type DatabaseSync, transaction } from '../db/database.js';
import { prepareCached } from '../db/repositories/util.js';
import { deleteMessage, recordMessageTombstone } from '../db/repositories/messages.js';
import {
  markAttachmentsDeleted,
  listAttachmentLocalPaths,
} from '../db/repositories/attachments.js';
import { recordAdminEvent } from '../db/repositories/admin-events.js';
import type { VisibilityClass } from '../db/repositories/channels.js';
import {
  computeEffectiveScope,
  narrowestMemoryScope,
  type EffectiveScope,
  type ScopeEvidenceChannel,
  type ScopeType,
  type VisibilityLookup,
} from './scope.js';

/**
 * Forget-message deletion workflow (Sections 27, 42.4, 43).
 *
 * An admin forget request tombstones one message: its normalized content and
 * attachments are purged, it drops out of FTS (the messages_au trigger fires on
 * the `deleted_at_ms` UPDATE), and every memory that drew evidence from it is
 * re-evaluated. The message row itself is retained for referential integrity
 * (episode_messages / memory_evidence reference it); only the content and the
 * evidence *links* are removed.
 *
 * Derived-memory handling is deterministic and fail-closed (Section 24.3):
 *  - a memory left with no remaining evidence is invalidated;
 *  - a memory whose recomputed scope would *broaden* (the statement may still
 *    encode removed restricted content) is routed to secure review rather than
 *    promoted;
 *  - a memory whose recomputed scope narrows or is unchanged is re-scoped in
 *    place.
 *
 * The whole operation is one transaction, and an admin event records what
 * happened without ever persisting message content.
 */

/** Per-memory outcome of a forget operation (for the audit and the response). */
export interface ForgetMemoryDisposition {
  memoryId: string;
  action: 'invalidated' | 'routed_to_review' | 'rescoped' | 'evidence_removed';
  previousScopeType: ScopeType;
  newScopeType: ScopeType;
}

export interface ForgetMessageInput {
  messageId: string;
  guildId: string;
  actorUserId: string;
  nowMs: number;
  /** Keep the deleted message's content columns (default false: purge them). */
  retainDeletedContent?: boolean;
}

export interface ForgetMessageResult {
  /** False when no message row exists for the id. */
  found: boolean;
  messageId: string;
  /** True when this call tombstoned the message (false if already deleted). */
  tombstoned: boolean;
  attachmentsMarkedDeleted: number;
  /** Local attachment paths the caller should unlink from disk (DB already cleared). */
  attachmentLocalPaths: string[];
  memories: ForgetMemoryDisposition[];
  adminEventId: string;
}

interface MemoryStateRow {
  id: string;
  scope_type: string;
  scope_key: string | null;
  status: string;
}

function readMemory(db: DatabaseSync, memoryId: string): MemoryStateRow | undefined {
  return prepareCached(
    db,
    'forget.memory_state',
    'SELECT id, scope_type, scope_key, status FROM memories WHERE id = ?',
  ).get(memoryId) as MemoryStateRow | undefined;
}

function remainingEvidence(
  db: DatabaseSync,
  memoryId: string,
): Array<{ channel_id: string; is_thread: number }> {
  return prepareCached(
    db,
    'forget.remaining_evidence',
    `SELECT m.channel_id, c.is_thread
       FROM memory_evidence me
       JOIN messages m ON m.id = me.message_id
       LEFT JOIN channels c ON c.id = m.channel_id
      WHERE me.memory_id = ? AND m.deleted_at_ms IS NULL`,
  ).all(memoryId) as Array<{ channel_id: string; is_thread: number }>;
}

function channelLookup(db: DatabaseSync): VisibilityLookup {
  return {
    visibilityClass: (id) => {
      const row = prepareCached(
        db,
        'forget.channel_visibility',
        'SELECT visibility_class FROM channels WHERE id = ? AND deleted_at_ms IS NULL',
      ).get(id) as { visibility_class: string } | undefined;
      return (row?.visibility_class ?? undefined) as VisibilityClass | undefined;
    },
    parentChannelId: (id) => {
      const row = prepareCached(
        db,
        'forget.channel_parent',
        'SELECT parent_id, is_thread FROM channels WHERE id = ?',
      ).get(id) as { parent_id: string | null; is_thread: number } | undefined;
      if (!row || row.is_thread !== 1) return null;
      return row.parent_id ?? null;
    },
  };
}

function setMemoryScope(
  db: DatabaseSync,
  memoryId: string,
  scope: EffectiveScope,
  nowMs: number,
): void {
  prepareCached(
    db,
    'forget.set_scope',
    `UPDATE memories
       SET scope_type = @scopeType, scope_key = @scopeKey, updated_at_ms = @now
     WHERE id = @id`,
  ).run({ id: memoryId, scopeType: scope.scopeType, scopeKey: scope.scopeKey, now: nowMs });
}

function invalidateMemoryRow(db: DatabaseSync, memoryId: string, nowMs: number): void {
  prepareCached(
    db,
    'forget.invalidate',
    `UPDATE memories
       SET status = 'invalidated', scope_type = 'review_only', scope_key = NULL,
           resolved_at_ms = @now, updated_at_ms = @now
     WHERE id = @id`,
  ).run({ id: memoryId, now: nowMs });
}

/**
 * Forget a single message: tombstone it, purge content/attachments, and
 * re-evaluate derived memories. Records an auditable admin event (no content).
 * Safe to call on an already-deleted or absent message — it records the attempt
 * and does no destructive work.
 */
export function forgetMessage(db: DatabaseSync, input: ForgetMessageInput): ForgetMessageResult {
  return transaction(db, () => {
    const retainDeletedContent = input.retainDeletedContent ?? false;

    const existing = prepareCached(
      db,
      'forget.read_message',
      'SELECT id FROM messages WHERE id = ?',
    ).get(input.messageId) as { id: string } | undefined;

    const dispositions: ForgetMemoryDisposition[] = [];
    let tombstoned = false;
    let attachmentsMarkedDeleted = 0;
    const attachmentLocalPaths: string[] = [];

    recordMessageTombstone(db, {
      messageId: input.messageId,
      guildId: input.guildId,
      deletedAtMs: input.nowMs,
    });

    if (existing) {
      // Capture local paths before the DB rows clear them, so the caller can unlink.
      attachmentLocalPaths.push(...listAttachmentLocalPaths(db, input.messageId));

      tombstoned = deleteMessage(db, input.messageId, {
        retainDeletedContent,
        nowMs: input.nowMs,
      }) > 0;
      attachmentsMarkedDeleted = markAttachmentsDeleted(db, input.messageId, input.nowMs);

      const lookup = channelLookup(db);
      const memoryIds = prepareCached(
        db,
        'forget.dependent_memories',
        'SELECT DISTINCT memory_id FROM memory_evidence WHERE message_id = ?',
      ).all(input.messageId) as Array<{ memory_id: string }>;

      for (const { memory_id } of memoryIds) {
        const memory = readMemory(db, memory_id);
        if (!memory) continue;

        // Remove the evidence link(s) to the forgotten message.
        prepareCached(
          db,
          'forget.delete_evidence',
          'DELETE FROM memory_evidence WHERE memory_id = ? AND message_id = ?',
        ).run(memory_id, input.messageId);

        const prevType = memory.scope_type as ScopeType;
        const evidence: ScopeEvidenceChannel[] = remainingEvidence(db, memory_id).map((r) => ({
          channelId: r.channel_id,
          isThread: r.is_thread === 1,
        }));

        let action: ForgetMemoryDisposition['action'];
        let newType: ScopeType;

        if (evidence.length === 0) {
          // No remaining support: invalidate if still active, else just note removal.
          if (memory.status === 'active') {
            invalidateMemoryRow(db, memory_id, input.nowMs);
            action = 'invalidated';
          } else {
            action = 'evidence_removed';
          }
          newType = 'review_only';
        } else {
          const newScope = computeEffectiveScope(evidence, lookup);
          const previousScope: EffectiveScope = {
            scopeType: prevType,
            scopeKey: memory.scope_key,
          };
          const safeScope = narrowestMemoryScope(previousScope, newScope);
          const wouldWiden =
            safeScope.scopeType !== newScope.scopeType || safeScope.scopeKey !== newScope.scopeKey;
          if (
            newScope.scopeType === 'review_only' ||
            wouldWiden
          ) {
            // Uncertain / would-broaden: route to secure review, never promote.
            if (prevType !== 'review_only') {
              setMemoryScope(db, memory_id, { scopeType: 'review_only', scopeKey: null }, input.nowMs);
              action = 'routed_to_review';
            } else {
              action = 'evidence_removed';
            }
            newType = 'review_only';
          } else if (newScope.scopeType !== prevType || newScope.scopeKey !== memory.scope_key) {
            setMemoryScope(db, memory_id, newScope, input.nowMs);
            action = 'rescoped';
            newType = newScope.scopeType;
          } else {
            action = 'evidence_removed';
            newType = newScope.scopeType;
          }
        }

        dispositions.push({
          memoryId: memory_id,
          action,
          previousScopeType: prevType,
          newScopeType: newType,
        });
      }
    }

    const adminEventId = recordAdminEvent(db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'forget_message',
      target: input.messageId,
      details: {
        found: existing !== undefined,
        tombstoned,
        retainDeletedContent,
        attachmentsMarkedDeleted,
        memories: dispositions.map((d) => ({ memoryId: d.memoryId, action: d.action })),
      },
      createdAtMs: input.nowMs,
    });

    return {
      found: existing !== undefined,
      messageId: input.messageId,
      tombstoned,
      attachmentsMarkedDeleted,
      attachmentLocalPaths,
      memories: dispositions,
      adminEventId,
    };
  });
}
