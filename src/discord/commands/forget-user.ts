import { type DatabaseSync } from '../../db/database.js';
import { authorizeAdmin, type AuthorizationReason } from '../authorization.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import type { EnqueueInput } from '../../jobs/types.js';

/**
 * `/cassandra forget-user` handler (Sections 27, 42.4, 43).
 *
 * Authorizes the caller, then enqueues a single per-user `forget_user` job. The
 * job does the bounded, restart-safe deletion asynchronously (a user may have a
 * lot of history); the command replies immediately with an ephemeral
 * acknowledgement and never echoes content. A per-user unique key collapses
 * duplicate command invocations while a forget is already queued or running.
 */

export const FORGET_USER_SUBCOMMAND = 'forget-user';
export const FORGET_USER_ID_OPTION = 'id';

/** Per-user active-unique key: at most one forget_user job per user at a time. */
export function forgetUserJobKey(userId: string): string {
  return `forget-user:user:${userId}`;
}

export interface HandleForgetUserInput {
  userId: string;
  actorUserId: string;
  guildId: string;
  memberRoleIds: readonly string[] | null;
}

export interface HandleForgetUserDeps {
  db: DatabaseSync;
  adminRoleIds: readonly string[];
  nowMs: number;
  enqueue: (input: EnqueueInput<'forget_user'>) => { id: string; enqueued: boolean };
}

export type ForgetUserCommandOutcome =
  | { kind: 'not_authorized'; reason: AuthorizationReason }
  | { kind: 'queued'; jobId: string }
  | { kind: 'already_running' };

/**
 * Run the forget-user command: authorize (audited on denial), then enqueue the
 * per-user job. Returns `already_running` when a forget for this user is already
 * active (unique-key collapse) rather than starting a second one.
 */
export function handleForgetUserCommand(
  input: HandleForgetUserInput,
  deps: HandleForgetUserDeps,
): ForgetUserCommandOutcome {
  const outcome = authorizeAdmin(input.memberRoleIds, deps.adminRoleIds);
  if (!outcome.authorized) {
    recordAdminEvent(deps.db, {
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      action: 'forget_user',
      target: input.userId,
      details: { authorized: false, reason: outcome.reason },
      createdAtMs: deps.nowMs,
    });
    return { kind: 'not_authorized', reason: outcome.reason };
  }

  const res = deps.enqueue({
    type: 'forget_user',
    payload: { userId: input.userId },
    uniqueKey: forgetUserJobKey(input.userId),
    runAfterMs: deps.nowMs,
    now: deps.nowMs,
  });
  if (res.enqueued) return { kind: 'queued', jobId: res.id };
  return { kind: 'already_running' };
}

/** Ephemeral reply. Contains no message content. */
export function formatForgetUserReply(userId: string, outcome: ForgetUserCommandOutcome): string {
  switch (outcome.kind) {
    case 'not_authorized':
      return 'You are not authorized to forget users.';
    case 'already_running':
      return `A forget operation for user \`${userId}\` is already in progress.`;
    case 'queued':
      return (
        `Queued removal of content and evidence for user \`${userId}\`. ` +
        'Dependent memories will be routed to secure review as needed.'
      );
  }
}
