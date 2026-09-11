import { type DatabaseSync } from '../../db/database.js';
import { prepareCached } from '../../db/repositories/util.js';
import { recordAdminEvent } from '../../db/repositories/admin-events.js';
import {
  forgetMessage,
  type ForgetMemoryDisposition,
  type ForgetMessageResult,
} from '../../memory/deletion.js';
import type { JobHandler } from '../worker.js';
import type { JobRow, EnqueueInput } from '../types.js';

/**
 * `forget_user` job handler (Sections 27, 42.4, 43).
 *
 * Removes one user's message content, attachment files, and evidence links in
 * durable batches. Each message is forgotten in its own transaction
 * ({@link forgetMessage}), so a crash mid-batch leaves every committed message
 * tombstoned; resumption is implicit because the next run re-queries only
 * messages that are still undeleted. Dependent memories are routed to secure
 * review or invalidated per-message; the handler aggregates those dispositions
 * and audits completion once no target-user content remains.
 *
 * The initial job (from the command) carries a per-user unique key so duplicate
 * command invocations collapse. Continuation jobs are enqueued *without* a
 * unique key (otherwise the DO-NOTHING enqueue conflict with the still-running
 * current job would drop them); each continuation re-enters the same idempotent
 * batch query.
 */

/** Messages processed per batch (Section 42.4: bounded, restart-safe batches). */
export const FORGET_USER_BATCH_SIZE = 200;

export interface ForgetUserBatchInput {
  userId: string;
  guildId: string;
  /** System/admin actor recorded on the audit events. */
  actorUserId: string;
  nowMs: number;
  /** Override the batch size (default {@link FORGET_USER_BATCH_SIZE}). */
  batchSize?: number;
}

export interface ForgetUserBatchResult {
  userId: string;
  /** Messages forgotten in this batch. */
  processed: number;
  /** Undeleted target-user messages remaining after this batch. */
  remaining: number;
  /** True when no target-user content remains. */
  complete: boolean;
  forgotten: ForgetMessageResult[];
  /** Memory dispositions aggregated across this batch's messages. */
  memoryDispositions: ForgetMemoryDisposition[];
}

/**
 * Forget one batch of a user's messages. Idempotent and restart-safe: it selects
 * only still-undeleted messages by the user, forgets each in its own transaction,
 * and reports how many remain. Re-running after an interruption continues exactly
 * where the durable state left off.
 */
export function forgetUserBatch(db: DatabaseSync, input: ForgetUserBatchInput): ForgetUserBatchResult {
  const batchSize = input.batchSize ?? FORGET_USER_BATCH_SIZE;

  const ids = prepareCached(
    db,
    'forget_user.select_batch',
    'SELECT id FROM messages WHERE author_id = ? AND deleted_at_ms IS NULL ORDER BY created_at_ms LIMIT ?',
  ).all(input.userId, batchSize) as Array<{ id: string }>;

  const forgotten: ForgetMessageResult[] = [];
  const memoryDispositions: ForgetMemoryDisposition[] = [];
  for (const { id } of ids) {
    const res = forgetMessage(db, {
      messageId: id,
      guildId: input.guildId,
      actorUserId: input.actorUserId,
      nowMs: input.nowMs,
    });
    forgotten.push(res);
    memoryDispositions.push(...res.memories);
  }

  const remaining = Number(
    prepareCached(
      db,
      'forget_user.remaining',
      'SELECT count(*) AS n FROM messages WHERE author_id = ? AND deleted_at_ms IS NULL',
    ).get(input.userId)?.n ?? 0,
  );

  return {
    userId: input.userId,
    processed: ids.length,
    remaining,
    complete: remaining === 0,
    forgotten,
    memoryDispositions,
  };
}

export interface ForgetUserHandlerDeps {
  db: DatabaseSync;
  guildId: string;
  /** System/admin actor recorded on the audit events. */
  actorUserId: string;
  batchSize?: number;
  /** Inject a clock for deterministic tests (default Date.now). */
  now?: () => number;
  /**
   * Enqueue a continuation job when a batch leaves work remaining. Injected so
   * tests can observe the continuation without a live worker.
   */
  enqueue?: (input: EnqueueInput<'forget_user'>) => { id: string; enqueued: boolean };
}

export interface ForgetUserHandlerResult {
  result: ForgetUserBatchResult;
  /** Present when a continuation job was enqueued. */
  continuation?: { id: string; enqueued: boolean };
}

/**
 * Build a `forget_user` handler. One batch per invocation; if messages remain the
 * handler enqueues a continuation, and when the user is fully forgotten it records
 * a completion admin event (no content). `runForgetUser(userId)` exposes the same
 * work for callers and tests.
 */
export function createForgetUserHandler(
  deps: ForgetUserHandlerDeps,
): JobHandler<'forget_user'> & {
  runForgetUser(userId: string): Promise<ForgetUserHandlerResult>;
} {
  const runForgetUser = async (userId: string): Promise<ForgetUserHandlerResult> => {
    const now = deps.now?.() ?? Date.now();
    const result = forgetUserBatch(deps.db, {
      userId,
      guildId: deps.guildId,
      actorUserId: deps.actorUserId,
      nowMs: now,
      batchSize: deps.batchSize,
    });

    let continuation: { id: string; enqueued: boolean } | undefined;
    if (!result.complete && deps.enqueue) {
      // No unique key: a continuation must always enqueue (the current job is
      // still running, so a unique-keyed enqueue would collapse to a no-op and
      // the chain would stall).
      continuation = deps.enqueue({
        type: 'forget_user',
        payload: { userId },
        runAfterMs: now,
        now,
      });
    } else if (result.complete) {
      const reviewCount = result.memoryDispositions.filter((m) => m.action === 'routed_to_review').length;
      const invalidatedCount = result.memoryDispositions.filter((m) => m.action === 'invalidated').length;
      recordAdminEvent(deps.db, {
        guildId: deps.guildId,
        actorUserId: deps.actorUserId,
        action: 'forget_user_complete',
        target: userId,
        details: {
          batchProcessed: result.processed,
          reviewRouted: reviewCount,
          invalidated: invalidatedCount,
        },
        createdAtMs: now,
      });
    }

    return { result, continuation };
  };

  const handler = async (payload: { userId: string }, _job: JobRow): Promise<void> => {
    await runForgetUser(payload.userId);
  };

  return Object.assign(handler, { runForgetUser });
}
