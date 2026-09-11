// ABOUTME: Tests the host-only staleness sweep that expires long-overdue memories.
// ABOUTME: Covers the horizon predicate, cohort-lease skip, audit rows, and idempotency.

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { createMemory } from '../../src/memory/repository.js';
import type { RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { expireStaleMemories } from '../../src/memory/maintenance.js';
import { enqueue } from '../../src/jobs/queue.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const CHANNEL = '100000000000000002';
const APP = '100000000000000009';
const NOW = 1_700_000_000_000;
const HORIZON_MS = 45 * 86_400_000;
const ANCIENT = NOW - HORIZON_MS - 1000;

const ORG_GRANT: RetrievalGrant = {
  includeOrgMessages: true,
  includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [],
};

let env: TestDb;

function addMessage(id: string, at = NOW): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: USER,
    authorDisplayName: 'Alice',
    content: 'evidence text',
    createdAtMs: at,
    editedAtMs: null,
    replyToMessageId: null,
    messageType: 0,
    flags: 0,
    pinned: false,
    mentionEveryone: false,
    mentionsJson: '[]',
    embedsJson: '[]',
    componentsJson: '[]',
    pollJson: null,
    rawJson: null,
    ingestedAtMs: at,
    updatedAtMs: at,
  });
}

function makeMemory(statement: string, evidenceIds: string[]): string {
  return createMemory(env.db, ORG_GRANT, {
    guildId: GUILD,
    type: 'prediction',
    statement,
    confidence: 0.7,
    importance: 0.5,
    evidence: evidenceIds.map((messageId) => ({ messageId, stance: 'origin' as const })),
    reviewAfterMs: NOW - 1000,
    now: NOW,
  });
}

function setReviewDate(id: string, reviewAfterMs: number): void {
  env.db.prepare('UPDATE memories SET review_after_ms = ? WHERE id = ?').run(reviewAfterMs, id);
}

function statusOf(id: string): string {
  const row = env.db.prepare('SELECT status FROM memories WHERE id = ?').get(id) as {
    status: string;
  };
  return row.status;
}

function auditRows(): Array<{ target: string; action: string; details_json: string }> {
  return env.db
    .prepare("SELECT target, action, details_json FROM admin_events WHERE action = 'memory_staleness_expire' ORDER BY target")
    .all() as Array<{ target: string; action: string; details_json: string }>;
}

function sweep(horizonMs: number = HORIZON_MS): string[] {
  return expireStaleMemories(env.db, {
    horizonMs,
    actorUserId: APP,
    guildId: GUILD,
    now: NOW,
  }).expiredIds;
}

describe('expireStaleMemories — Section 12.4 staleness horizon', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(CHANNEL);
    addMessage('e-recent');
    addMessage('e-old', ANCIENT);
  });

  it('expires memories whose review date and newest evidence both passed the horizon', () => {
    // The memory row itself is fresh (extracted today from an old conversation);
    // staleness anchors on the evidence messages, not on extraction time.
    const stale = makeMemory('Ancient unresolved bet.', ['e-old']);
    setReviewDate(stale, ANCIENT);
    const fresh = makeMemory('Recently due item.', ['e-recent']);

    const expired = sweep();

    expect(expired).toEqual([stale]);
    expect(statusOf(stale)).toBe('expired');
    expect(statusOf(fresh)).toBe('active');
  });

  it('keeps a past-horizon review date when the newest evidence is recent', () => {
    const active = makeMemory('Old date, live thread.', ['e-old', 'e-recent']);
    setReviewDate(active, ANCIENT);

    expect(sweep()).toEqual([]);
    expect(statusOf(active)).toBe('active');
  });

  it('keeps a recently due review date despite old evidence', () => {
    const dueNow = makeMemory('Old promise, review due now.', ['e-old']);

    expect(sweep()).toEqual([]);
    expect(statusOf(dueNow)).toBe('active');
  });

  it('skips memories leased to a queued scheduled-review cohort', () => {
    const leased = makeMemory('Leased stale memory.', ['e-old']);
    setReviewDate(leased, ANCIENT);
    const queued = enqueue(env.db, {
      type: 'review_due_memory_cohort',
      payload: {
        routeKind: 'working',
        targetChannelId: CHANNEL,
        subjects: [{ memoryId: leased, memoryFingerprint: 'fp-1' }],
      },
      now: NOW,
    });
    env.db
      .prepare(
        `INSERT INTO scheduled_review_cohort_subject_leases
           (memory_id, job_id, memory_fingerprint, created_at_ms)
         VALUES (?, ?, ?, ?)`,
      )
      .run(leased, queued.id, 'fp-1', NOW);

    expect(sweep()).toEqual([]);
    expect(statusOf(leased)).toBe('active');
  });

  it('writes one content-free audit event per expired memory', () => {
    const stale = makeMemory('Audited stale memory.', ['e-old']);
    setReviewDate(stale, ANCIENT);

    sweep();

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe(stale);
    expect(JSON.parse(rows[0]!.details_json)).toEqual({
      reviewAfterMs: ANCIENT,
      newestEvidenceAtMs: ANCIENT,
      horizonMs: HORIZON_MS,
    });
    expect(rows[0]!.details_json).not.toContain('Audited stale memory');
  });

  it('is a safe no-op on re-run', () => {
    const stale = makeMemory('Once-expired memory.', ['e-old']);
    setReviewDate(stale, ANCIENT);

    expect(sweep()).toEqual([stale]);
    expect(sweep()).toEqual([]);
    expect(auditRows()).toHaveLength(1);
  });

  it('does nothing when the horizon is disabled', () => {
    const stale = makeMemory('Stale but horizon off.', ['e-old']);
    setReviewDate(stale, ANCIENT);

    expect(sweep(0)).toEqual([]);
    expect(statusOf(stale)).toBe('active');
    expect(auditRows()).toHaveLength(0);
  });

  it('drains more rows than one batch', () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const id = makeMemory(`stale ${index}`, ['e-old']);
      setReviewDate(id, ANCIENT - index);
      ids.push(id);
    }

    const expired = expireStaleMemories(env.db, {
      horizonMs: HORIZON_MS,
      actorUserId: APP,
      guildId: GUILD,
      now: NOW,
      batchSize: 2,
    }).expiredIds;

    expect(expired.length).toBe(5);
    expect(new Set(expired)).toEqual(new Set(ids));
    for (const id of ids) expect(statusOf(id)).toBe('expired');
  });
});
