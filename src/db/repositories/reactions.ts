import { type DatabaseSync } from '../database.js';
import { prepareCached } from './util.js';

/**
 * Reaction persistence (Section 9.3, 9.9).
 *
 * Two tables cooperate:
 *   - `reactions`        — one row per (message, user, emoji). Populated from
 *                          live Gateway events, which are the only source of
 *                          per-user data.
 *   - `reaction_counts`  — the best-known aggregate count per (message, emoji),
 *                          with a `source` column recording whether the value
 *                          last came from REST backfill or live tracking.
 *
 * The live count is always recomputed from the `reactions` rows, so duplicate
 * and out-of-order events converge to the correct aggregate.
 */

export interface ReactionAddInput {
  messageId: string;
  userId: string;
  emojiKey: string;
  observedAtMs: number;
}

const ADD_SQL = `
  INSERT INTO reactions (message_id, user_id, emoji_key, created_at_ms, present, updated_at_ms, delta)
  VALUES (@message_id, @user_id, @emoji_key, @created_at_ms, 1, @created_at_ms, 1)
  ON CONFLICT(message_id, user_id, emoji_key) DO UPDATE SET
    present = 1, updated_at_ms = excluded.updated_at_ms,
    delta = min(1, reactions.delta + 1)
  WHERE reactions.present = 0 AND excluded.updated_at_ms >= reactions.updated_at_ms
`;

/**
 * Record a per-user reaction. Idempotent: re-adding the same (message, user,
 * emoji) is a no-op. The affected emoji's aggregate is recomputed. Returns true
 * when a new row was inserted.
 */
export function addReaction(db: DatabaseSync, input: ReactionAddInput): boolean {
  const stmt = prepareCached(db, 'reactions.add', ADD_SQL);
  const changes = Number(
    stmt.run({
      message_id: input.messageId,
      user_id: input.userId,
      emoji_key: input.emojiKey,
      created_at_ms: input.observedAtMs,
    }).changes,
  );
  recomputeLiveCount(db, input.messageId, input.emojiKey, input.observedAtMs);
  return changes > 0;
}

/**
 * Remove a per-user reaction. Idempotent: removing an absent row is a no-op.
 * Returns true when a row was actually deleted.
 */
export function removeReaction(
  db: DatabaseSync,
  input: Omit<ReactionAddInput, 'observedAtMs'> & { observedAtMs: number },
): boolean {
  const existing = prepareCached(db, 'reactions.state',
    'SELECT present, updated_at_ms FROM reactions WHERE message_id=? AND user_id=? AND emoji_key=?')
    .get(input.messageId, input.userId, input.emojiKey) as { present: number; updated_at_ms: number } | undefined;
  const baseline = prepareCached(db, 'reactions.baseline',
    'SELECT baseline_count FROM reaction_counts WHERE message_id=? AND emoji_key=?')
    .get(input.messageId, input.emojiKey) as { baseline_count: number } | undefined;
  if ((!existing && (baseline?.baseline_count ?? 0) === 0) ||
      (existing && (existing.present === 0 || existing.updated_at_ms > input.observedAtMs))) return false;
  const changes = Number(prepareCached(db, 'reactions.remove', `
    INSERT INTO reactions (message_id,user_id,emoji_key,created_at_ms,present,updated_at_ms,delta)
    VALUES (?,?,?,?,0,?,-1)
    ON CONFLICT(message_id,user_id,emoji_key) DO UPDATE SET
      present=0,updated_at_ms=excluded.updated_at_ms,delta=max(-1,reactions.delta-1)
    WHERE reactions.present=1 AND excluded.updated_at_ms >= reactions.updated_at_ms`)
    .run(input.messageId, input.userId, input.emojiKey, input.observedAtMs, input.observedAtMs).changes);
  recomputeLiveCount(db, input.messageId, input.emojiKey, input.observedAtMs);
  return changes > 0;
}

/**
 * Remove every reaction on a message (MESSAGE_REACTION_REMOVE_ALL). Clears the
 * per-user rows and every aggregate count for the message, regardless of
 * source — Discord reports all reactions gone. Returns the number of per-user
 * rows removed.
 */
export function removeAllReactions(db: DatabaseSync, messageId: string, _nowMs: number): number {
  const removed = Number(
    prepareCached(db, 'reactions.remove_all.rows', 'DELETE FROM reactions WHERE message_id = ?').run(
      messageId,
    ).changes,
  );
  prepareCached(
    db,
    'reactions.remove_all.counts',
    'DELETE FROM reaction_counts WHERE message_id = ?',
  ).run(messageId);
  return removed;
}

const LIVE_UPSERT_SQL = `
  INSERT INTO reaction_counts (message_id, emoji_key, count, source, updated_at_ms)
  VALUES (@message_id, @emoji_key, @count, 'live', @updated_at_ms)
  ON CONFLICT(message_id, emoji_key) DO UPDATE SET
    count = excluded.count,
    source = 'live',
    updated_at_ms = excluded.updated_at_ms
  WHERE excluded.count IS NOT reaction_counts.count
     OR reaction_counts.source IS NOT 'live'
`;

/**
 * Recompute the live aggregate for one (message, emoji) from its per-user rows.
 * When the count is zero the aggregate row is deleted so the table holds only
 * emojis that currently have reactions. Idempotent and order-independent.
 */
export function recomputeLiveCount(
  db: DatabaseSync,
  messageId: string,
  emojiKey: string,
  nowMs: number,
): void {
  const countRow = prepareCached(db, 'reactions.effective_count', `
    SELECT max(0, COALESCE(rc.baseline_count,0) + COALESCE(SUM(r.delta),0)) AS n
      FROM (SELECT 1) seed
      LEFT JOIN reaction_counts rc ON rc.message_id=? AND rc.emoji_key=?
      LEFT JOIN reactions r ON r.message_id=? AND r.emoji_key=?
       AND r.updated_at_ms > COALESCE(rc.baseline_at_ms,0)`)
    .get(messageId, emojiKey, messageId, emojiKey) as { n: number };
  const count = Number(countRow?.n ?? 0);
  if (count > 0) {
    prepareCached(db, 'reactions.live_upsert', LIVE_UPSERT_SQL).run({
      message_id: messageId,
      emoji_key: emojiKey,
      count,
      updated_at_ms: nowMs,
    });
  } else {
    prepareCached(
      db,
      'reactions.live_zero',
      'DELETE FROM reaction_counts WHERE message_id = ? AND emoji_key = ?',
    ).run(messageId, emojiKey);
  }
}

// ---- REST backfill aggregate counts (Section 9.9) ---------------------------

export interface ReactionCountInput {
  messageId: string;
  emojiKey: string;
  count: number;
}

const BACKFILL_UPSERT_SQL = `
  INSERT INTO reaction_counts (message_id, emoji_key, count, source, updated_at_ms, baseline_count, baseline_at_ms)
  VALUES (@message_id, @emoji_key, @count, 'backfill', @updated_at_ms, @count, @updated_at_ms)
  ON CONFLICT(message_id, emoji_key) DO UPDATE SET
    count = excluded.count,
    baseline_count = excluded.count,
    baseline_at_ms = excluded.updated_at_ms,
    source = 'backfill',
    updated_at_ms = excluded.updated_at_ms
  WHERE excluded.updated_at_ms >= reaction_counts.updated_at_ms
`;

/** One (emoji, count) entry for a message, as used by read paths. */
export interface ReactionCountRow {
  messageId: string;
  emojiKey: string;
  count: number;
}

/**
 * Read the aggregate reaction counts for one message — every emoji that
 * currently has reactions, with no per-user data. Used to build the episode
 * review payload (Section 11.5). Queries a single cached statement per message
 * rather than a variable-length `IN (...)` list, so the statement cache is not
 * fragmented by episode size.
 */
export function getReactionCountsForMessage(
  db: DatabaseSync,
  messageId: string,
): ReactionCountRow[] {
  const rows = prepareCached(
    db,
    'reaction_counts.for_message',
    'SELECT emoji_key, count FROM reaction_counts WHERE message_id = ?',
  ).all(messageId) as { emoji_key: string; count: number | string }[];
  return rows.map((r) => ({ messageId, emojiKey: r.emoji_key, count: Number(r.count) }));
}

/**
 * Persist aggregate counts as REST backfill returns them. No-op when the stored
 * count and source already match. Per-user rows are never fetched during
 * backfill (Section 9.9).
 */
export function upsertBackfillReactionCounts(
  db: DatabaseSync,
  counts: ReactionCountInput[],
  updatedAtMs: number,
): number {
  if (counts.length === 0) return 0;
  const stmt = prepareCached(db, 'reaction_counts.backfill', BACKFILL_UPSERT_SQL);
  let changed = 0;
  for (const c of counts) {
    changed += Number(
      stmt.run({
        message_id: c.messageId,
        emoji_key: c.emojiKey,
        count: Math.max(0, Math.trunc(c.count)),
        updated_at_ms: updatedAtMs,
      }).changes,
    );
    prepareCached(db, 'reactions.prune_before_baseline',
      'DELETE FROM reactions WHERE message_id=? AND emoji_key=? AND updated_at_ms <= ?')
      .run(c.messageId, c.emojiKey, updatedAtMs);
  }
  return changed;
}

/**
 * Replace the REST aggregate snapshot for one message. Missing emoji have a
 * zero baseline. Live events observed after the snapshot remain applied.
 */
export function replaceBackfillReactionCounts(
  db: DatabaseSync,
  messageId: string,
  counts: ReactionCountInput[],
  updatedAtMs: number,
): number {
  let changed = upsertBackfillReactionCounts(db, counts, updatedAtMs);
  const included = new Set(counts.map((count) => count.emojiKey));
  const existing = prepareCached(
    db,
    'reaction_counts.keys_for_message',
    'SELECT emoji_key FROM reaction_counts WHERE message_id = ?',
  ).all(messageId) as Array<{ emoji_key: string }>;

  for (const row of existing) {
    if (included.has(row.emoji_key)) continue;
    changed += Number(prepareCached(db, 'reaction_counts.clear_missing_snapshot', `
      UPDATE reaction_counts SET baseline_count=0, baseline_at_ms=?, count=0,
        source='backfill', updated_at_ms=?
      WHERE message_id=? AND emoji_key=? AND updated_at_ms <= ?`)
      .run(updatedAtMs, updatedAtMs, messageId, row.emoji_key, updatedAtMs).changes);
    prepareCached(db, 'reactions.prune_missing_snapshot',
      'DELETE FROM reactions WHERE message_id=? AND emoji_key=? AND updated_at_ms <= ?')
      .run(messageId, row.emoji_key, updatedAtMs);
    recomputeLiveCount(db, messageId, row.emoji_key, updatedAtMs);
  }
  return changed;
}
