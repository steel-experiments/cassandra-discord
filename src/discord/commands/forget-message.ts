import { type DatabaseSync } from '../../db/database.js';
import { authorizeAdmin, type AuthorizationReason } from '../authorization.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import {
  forgetMessage,
  type ForgetMessageResult,
} from '../../memory/deletion.js';

/**
 * `/cassandra forget-message` handler (Sections 27, 42.4, 43).
 *
 * Thin command layer over {@link forgetMessage}: authorize the caller (fail
 * closed, audited on denial), run the deletion workflow, unlink any local
 * attachment files, and produce an ephemeral reply that summarizes the outcome
 * without ever echoing message content. Wiring this to a live discord.js
 * `ChatInputCommandInteraction` (reading the `id` option and the member's roles)
 * is the dispatcher's job; this module stays free of discord.js types so it is
 * trivially testable.
 */

export const FORGET_MESSAGE_SUBCOMMAND = 'forget-message';
export const FORGET_MESSAGE_ID_OPTION = 'id';

export interface HandleForgetMessageInput {
  /** The message id supplied as the command's `id` option. */
  messageId: string;
  actorUserId: string;
  guildId: string;
  /** The caller's role ids, or null when unresolved (fail-closed). */
  memberRoleIds: readonly string[] | null;
}

export interface HandleForgetMessageDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  /** Unlink a local attachment file from disk. Optional; defaults to no-op. */
  unlinkAttachment?: (path: string) => void;
}

export type ForgetMessageCommandOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'ok'; result: ForgetMessageResult };

/**
 * Run the forget-message command. Authorization is checked first and recorded
 * on denial; on success the deletion workflow runs (which records its own
 * auditable event) and local attachment files are unlinked.
 */
export function handleForgetMessageCommand(
  input: HandleForgetMessageInput,
  deps: HandleForgetMessageDeps,
): ForgetMessageCommandOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'forget_message',
      target: input.messageId,
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const result = forgetMessage(deps.db, {
    messageId: input.messageId,
    guildId: input.guildId,
    actorUserId: input.actorUserId,
    nowMs: deps.nowMs,
  });

  const unlink = deps.unlinkAttachment;
  if (unlink) {
    for (const path of result.attachmentLocalPaths) {
      try {
        unlink(path);
      } catch {
        // A missing file must not fail the command; the DB row is already cleared.
      }
    }
  }

  return { kind: 'ok', result };
}

/**
 * Format an ephemeral reply summarizing the outcome. Contains no message
 * content — only counts and per-memory dispositions (Section 43.4: logs/replies
 * without message content).
 */
export function formatForgetMessageReply(
  messageId: string,
  outcome: ForgetMessageCommandOutcome,
): string {
  if (outcome.kind === 'not_authorized') {
    return 'You are not authorized to forget messages.';
  }
  const r = outcome.result;
  if (!r.found) {
    return `No message found for id \`${messageId}\`.`;
  }
  const counts = { invalidated: 0, routed_to_review: 0, rescoped: 0, evidence_removed: 0 };
  for (const m of r.memories) counts[m.action] += 1;
  const parts = [
    `Forgot message \`${messageId}\`.`,
    r.tombstoned ? 'Content and attachments purged.' : 'Already deleted — re-confirmed.',
    `Attachments cleared: ${r.attachmentsMarkedDeleted}.`,
    `Memories reviewed: ${r.memories.length}` +
      ` (invalidated ${counts.invalidated}, review ${counts.routed_to_review}, re-scoped ${counts.rescoped}, unchanged ${counts.evidence_removed}).`,
  ];
  return parts.join(' ');
}
