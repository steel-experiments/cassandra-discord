import { describe, it, expect, afterEach } from 'vitest';
import { type DatabaseSync } from '../../src/db/database.js';
import { createTestDb, seedIdentity } from '../helpers/db.js';
import {
  forgetUserBatch,
  createForgetUserHandler,
} from '../../src/jobs/handlers/forget-user.js';
import {
  handleForgetUserCommand,
  formatForgetUserReply,
  forgetUserJobKey,
} from '../../src/discord/commands/forget-user.js';
import { enqueue } from '../../src/jobs/queue.js';

/**
 * forget-user deletion workflow (Sections 27, 42.4, 43).
 *
 * Acceptance: the workflow resumes after interruption and leaves no retrievable
 * target-user content or orphaned evidence links.
 */

const NOW = 1_700_000_000_000;
const RUN_NOW = NOW + 1000;
const ORG = '300000000000000001';
const RESTRICTED_A = '300000000000000010';
const ADMIN_ROLE = '900000000000000001';

let setup: ReturnType<typeof createTestDb> | null = null;
function freshDb(): DatabaseSync {
  setup = createTestDb();
  return setup.db;
}
afterEach(() => {
  setup?.cleanup();
  setup = null;
});

function seedChannel(d: DatabaseSync, id: string, visibility: string, guildId: string): void {
  d.prepare(
    `INSERT INTO channels (id, guild_id, parent_id, type, name, is_thread, is_archived, is_locked,
       ingest_enabled, visibility_class, allow_interventions, discovered_at_ms, updated_at_ms)
     VALUES (?, ?, NULL, 0, ?, 0, 0, 0, 1, ?, 1, ?, ?)`,
  ).run(id, guildId, id, visibility, NOW, NOW);
}
function seedUser(d: DatabaseSync, id: string): void {
  d.prepare(
    `INSERT INTO users (id, username, global_name, is_bot, first_seen_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id, id, id, NOW, NOW);
}
function seedMessage(
  d: DatabaseSync,
  id: string,
  channelId: string,
  guildId: string,
  authorId: string,
  content: string,
): void {
  d.prepare(
    `INSERT INTO messages (id, guild_id, channel_id, author_id, author_display_name, content,
       created_at_ms, ingested_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, guildId, channelId, authorId, authorId, content, NOW, NOW, NOW);
}
function seedMemory(d: DatabaseSync, id: string, guildId: string, scopeType: string, scopeKey: string | null): void {
  d.prepare(
    `INSERT INTO memories (id, guild_id, scope_type, scope_key, type, statement, status,
       confidence, importance, first_seen_at_ms, last_confirmed_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'decision', ?, 'active', 0.8, 0.7, ?, ?, ?, ?)`,
  ).run(id, guildId, scopeType, scopeKey, `memory ${id}`, NOW, NOW, NOW, NOW);
}
function seedEvidence(d: DatabaseSync, memoryId: string, messageId: string, stance = 'origin'): void {
  d.prepare(
    `INSERT INTO memory_evidence (memory_id, message_id, stance, weight, created_at_ms)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(memoryId, messageId, stance, NOW);
}
function undeletedCountByUser(d: DatabaseSync, userId: string): number {
  return Number(
    d.prepare('SELECT count(*) AS n FROM messages WHERE author_id = ? AND deleted_at_ms IS NULL').get(userId)?.n ?? 0,
  );
}
function orphanedEvidenceCount(d: DatabaseSync, userId: string): number {
  // Evidence links that still reference a deleted message by the target user.
  return Number(
    d
      .prepare(
        `SELECT count(*) AS n FROM memory_evidence me
         JOIN messages m ON m.id = me.message_id
         WHERE m.author_id = ? AND m.deleted_at_ms IS NOT NULL`,
      )
      .get(userId)?.n ?? 0,
  );
}

function seedWorld(d: DatabaseSync) {
  const { guildId, userId: adminId } = seedIdentity(d);
  seedChannel(d, ORG, 'org', guildId);
  seedChannel(d, RESTRICTED_A, 'restricted', guildId);
  const target = '400000000000000020';
  const other = '400000000000000021';
  seedUser(d, target);
  seedUser(d, other);
  return { guildId, adminId, target, other };
}

describe('forgetUserBatch — restart-safe batched removal', () => {
  it('resumes across batches until no target-user content remains', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    for (let i = 0; i < 5; i++) seedMessage(d, `tm${i}`, ORG, guildId, target, `content-${i}`);

    const b1 = forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW, batchSize: 2 });
    expect(b1.processed).toBe(2);
    expect(b1.remaining).toBe(3);
    expect(b1.complete).toBe(false);

    const b2 = forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW, batchSize: 2 });
    expect(b2.processed).toBe(2);
    expect(b2.remaining).toBe(1);

    const b3 = forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW, batchSize: 2 });
    expect(b3.processed).toBe(1);
    expect(b3.remaining).toBe(0);
    expect(b3.complete).toBe(true);

    expect(undeletedCountByUser(d, target)).toBe(0);
    // Tombstones retained for integrity (rows still present, just deleted).
    const tombstoned = d.prepare('SELECT count(*) AS n FROM messages WHERE author_id = ? AND deleted_at_ms IS NOT NULL').get(target)?.n;
    expect(tombstoned).toBe(5);
  });

  it('is idempotent: a batch on a fully-forgotten user is a no-op', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    seedMessage(d, 'tm0', ORG, guildId, target, 'only');
    forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW });
    const again = forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW });
    expect(again.processed).toBe(0);
    expect(again.complete).toBe(true);
  });

  it('leaves other users content untouched', () => {
    const d = freshDb();
    const { guildId, adminId, target, other } = seedWorld(d);
    seedMessage(d, 'tm0', ORG, guildId, target, 'target content');
    seedMessage(d, 'om0', ORG, guildId, other, 'other content');
    forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW });
    expect(undeletedCountByUser(d, target)).toBe(0);
    expect(undeletedCountByUser(d, other)).toBe(1);
  });

  it('leaves no retrievable content (FTS) and no orphaned evidence links', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    const UNIQUE = 'uniqftstoken';
    seedMessage(d, 'tm0', ORG, guildId, target, UNIQUE);
    seedMemory(d, 'mem1', guildId, 'org', null);
    seedEvidence(d, 'mem1', 'tm0');

    expect(undeletedCountByUser(d, target)).toBe(1);
    expect(orphanedEvidenceCount(d, target)).toBe(0); // link exists, message not yet deleted

    forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW });

    expect(undeletedCountByUser(d, target)).toBe(0);
    const fts = d.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(UNIQUE)?.n;
    expect(fts).toBe(0); // content absent from retrieval
    expect(orphanedEvidenceCount(d, target)).toBe(0); // no orphaned links
  });

  it('routes dependent memories to secure review and aggregates dispositions', () => {
    const d = freshDb();
    const { guildId, adminId, target, other } = seedWorld(d);
    // org evidence by ANOTHER user survives the forget; restricted evidence by
    // the target is removed, which would broaden the memory's scope to org.
    seedMessage(d, 'orgOther', ORG, guildId, other, 'org evidence');
    seedMessage(d, 'rest1', RESTRICTED_A, guildId, target, 'restricted evidence');
    seedMemory(d, 'mem1', guildId, 'channel', RESTRICTED_A);
    seedEvidence(d, 'mem1', 'orgOther');
    seedEvidence(d, 'mem1', 'rest1');

    const res = forgetUserBatch(d, { userId: target, guildId, actorUserId: adminId, nowMs: RUN_NOW });
    // Forgetting rest1 (restricted) leaves only org evidence -> would broaden to org -> routed to review.
    expect(res.memoryDispositions.some((m) => m.action === 'routed_to_review')).toBe(true);
  });
});

describe('createForgetUserHandler — continuation and completion', () => {
  it('enqueues a unique-less continuation when a batch leaves work remaining', async () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    for (let i = 0; i < 3; i++) seedMessage(d, `tm${i}`, ORG, guildId, target, `c-${i}`);
    const enqueued: unknown[] = [];
    const handler = createForgetUserHandler({
      db: d,
      guildId,
      actorUserId: adminId,
      batchSize: 2,
      now: () => RUN_NOW,
      enqueue: (input) => {
        enqueued.push(input);
        return { id: 'cont-1', enqueued: true };
      },
    });
    const out = await handler.runForgetUser(target);
    expect(out.result.complete).toBe(false);
    expect(out.continuation).toEqual({ id: 'cont-1', enqueued: true });
    expect(enqueued).toHaveLength(1);
    const call = enqueued[0] as { type: string; payload: { userId: string }; uniqueKey?: string | null };
    expect(call.type).toBe('forget_user');
    expect(call.payload.userId).toBe(target);
    expect(call.uniqueKey).toBeUndefined(); // continuation must not carry a unique key
  });

  it('records a completion admin event and enqueues no continuation when done', async () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    seedMessage(d, 'tm0', ORG, guildId, target, 'one');
    let enqueueCalls = 0;
    const handler = createForgetUserHandler({
      db: d,
      guildId,
      actorUserId: adminId,
      now: () => RUN_NOW,
      enqueue: () => {
        enqueueCalls += 1;
        return { id: 'x', enqueued: true };
      },
    });
    const out = await handler.runForgetUser(target);
    expect(out.result.complete).toBe(true);
    expect(out.continuation).toBeUndefined();
    expect(enqueueCalls).toBe(0);
    // Completion event recorded.
    const ev = d
      .prepare("SELECT action, target FROM admin_events WHERE action = 'forget_user_complete'")
      .get() as { action: string; target: string };
    expect(ev.target).toBe(target);
  });

  it('the registered handler shape runs without throwing', async () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    seedMessage(d, 'tm0', ORG, guildId, target, 'one');
    const handler = createForgetUserHandler({ db: d, guildId, actorUserId: adminId, now: () => RUN_NOW });
    const job = { id: 'j1', type: 'forget_user' as const, unique_key: null, payload_json: JSON.stringify({ userId: target }), status: 'running' as const, priority: 100, run_after_ms: RUN_NOW, lease_owner: null, lease_until_ms: null, attempts: 0, max_attempts: 10, last_error: null, created_at_ms: NOW, updated_at_ms: NOW, completed_at_ms: null };
    await expect(handler({ userId: target }, job)).resolves.toBeUndefined();
  });
});

describe('handleForgetUserCommand — authorization and enqueue', () => {
  it('authorizes and enqueues a per-user unique job', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    let enqueuedInput: unknown = null;
    const out = handleForgetUserCommand(
      { userId: target, actorUserId: adminId, guildId, memberRoleIds: [ADMIN_ROLE] },
      {
        db: d,
        adminRoleIds: [ADMIN_ROLE],
        nowMs: RUN_NOW,
        enqueue: (input) => {
          enqueuedInput = input;
          return { id: 'job-1', enqueued: true };
        },
      },
    );
    expect(out.kind).toBe('queued');
    if (out.kind !== 'queued') return;
    expect(out.jobId).toBe('job-1');
    expect((enqueuedInput as { uniqueKey: string }).uniqueKey).toBe(forgetUserJobKey(target));
  });

  it('reports already_running when the unique enqueue collapses', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    const out = handleForgetUserCommand(
      { userId: target, actorUserId: adminId, guildId, memberRoleIds: [ADMIN_ROLE] },
      {
        db: d,
        adminRoleIds: [ADMIN_ROLE],
        nowMs: RUN_NOW,
        enqueue: () => ({ id: 'existing', enqueued: false }),
      },
    );
    expect(out.kind).toBe('already_running');
  });

  it('denies fail-closed and audits when unauthorized', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    let enqueueCalls = 0;
    const out = handleForgetUserCommand(
      { userId: target, actorUserId: adminId, guildId, memberRoleIds: ['000000000000000009'] },
      {
        db: d,
        adminRoleIds: [ADMIN_ROLE],
        nowMs: RUN_NOW,
        enqueue: () => {
          enqueueCalls += 1;
          return { id: 'x', enqueued: true };
        },
      },
    );
    expect(out.kind).toBe('not_authorized');
    expect(enqueueCalls).toBe(0);
    const ev = d
      .prepare("SELECT details_json FROM admin_events WHERE action = 'forget_user'")
      .get() as { details_json: string };
    expect(JSON.parse(ev.details_json)).toMatchObject({ authorized: false });
  });

  it('enqueue collapse is idempotent end-to-end against the real queue', () => {
    const d = freshDb();
    const { guildId, adminId, target } = seedWorld(d);
    const first = handleForgetUserCommand(
      { userId: target, actorUserId: adminId, guildId, memberRoleIds: [ADMIN_ROLE] },
      { db: d, adminRoleIds: [ADMIN_ROLE], nowMs: RUN_NOW, enqueue: (i) => enqueue(d, i) },
    );
    const second = handleForgetUserCommand(
      { userId: target, actorUserId: adminId, guildId, memberRoleIds: [ADMIN_ROLE] },
      { db: d, adminRoleIds: [ADMIN_ROLE], nowMs: RUN_NOW, enqueue: (i) => enqueue(d, i) },
    );
    expect(first.kind).toBe('queued');
    expect(second.kind).toBe('already_running');
  });

  it('reply never echoes message content', () => {
    const secret = 'SUPERSECRET-TOKEN';
    const r1 = formatForgetUserReply('u1', { kind: 'queued', jobId: 'j1' });
    expect(r1).toContain('u1');
    expect(r1).not.toContain(secret);
    expect(formatForgetUserReply('u1', { kind: 'already_running' })).toContain('in progress');
    expect(formatForgetUserReply('u1', { kind: 'not_authorized', reason: 'not_authorized' })).toContain(
      'not authorized',
    );
  });
});
