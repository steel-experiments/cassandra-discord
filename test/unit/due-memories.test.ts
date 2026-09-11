import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import {
  createMemory,
  type RetrievalGrant,
  type MemoryEvidenceInput,
} from '../../src/memory/repository.js';
import {
  selectDueMemories,
  selectDueMemoriesForDispatch,
  scheduleDueReview,
  DUE_REVIEW_UNIQUE_KEY,
} from '../../src/memory/due.js';

const GUILD = '100000000000000001';
const USER = '100000000000000003';
const CHANNEL = '100000000000000002';
const NOW = 1_700_000_000_000;

const ORG_GRANT: RetrievalGrant = { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [] };

let env: TestDb;

function addMessage(id: string, content: string, at = NOW): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: USER,
    authorDisplayName: 'Alice',
    content,
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

function ev(id: string): MemoryEvidenceInput {
  return { messageId: id, stance: 'origin' };
}

function makeMemory(
  type: 'prediction' | 'assumption' | 'decision',
  statement: string,
  reviewAfterMs: number | null,
  evidence: MemoryEvidenceInput[],
): string {
  return createMemory(env.db, ORG_GRANT, {
    guildId: GUILD,
    type,
    statement,
    confidence: 0.7,
    importance: 0.5,
    evidence,
    reviewAfterMs: reviewAfterMs ?? undefined,
    now: NOW,
  });
}

function setStatus(id: string, status: 'resolved' | 'superseded' | 'invalidated'): void {
  env.db.prepare('UPDATE memories SET status = ? WHERE id = ?').run(status, id);
}

function dueJobs(): Array<{ unique_key: string | null; status: string; payload_json: string }> {
  return env.db
    .prepare('SELECT unique_key, status, payload_json FROM jobs WHERE type = ?')
    .all('review_due_memories') as Array<{ unique_key: string | null; status: string; payload_json: string }>;
}

describe('due-memory selection', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(CHANNEL);
    addMessage('e-a1', 'we predict trial lifts activation');
    addMessage('e-a2', 'second supporting note');
  });

  it('selects only active memories whose review date has elapsed, most-overdue first', () => {
    const dueA = makeMemory('prediction', 'Trial lifts activation 10%.', NOW - 1000, [ev('e-a1'), ev('e-a2')]);
    const dueB = makeMemory('assumption', 'Onboarding owns the dashboard.', NOW - 500, [ev('e-a1')]);
    const future = makeMemory('prediction', 'Q3 reprice.', NOW + 1000, [ev('e-a1')]);
    const noDate = makeMemory('decision', 'Adopt the trial.', undefined, [ev('e-a1')]);
    const resolvedDue = makeMemory('prediction', 'Old resolved bet.', NOW - 2000, [ev('e-a1')]);
    setStatus(resolvedDue, 'resolved');
    void future;
    void noDate;

    const due = selectDueMemories(env.db, { now: NOW });

    expect(due.map((d) => d.memoryId)).toEqual([dueA, dueB]);
    expect(due[0]!.type).toBe('prediction');
    expect(due[0]!.reviewAfterMs).toBe(NOW - 1000);
    // Non-active material is excluded despite being more overdue.
    expect(due.find((d) => d.memoryId === resolvedDue)).toBeUndefined();
  });

  it('attaches recomputed effective scope and evidence density', () => {
    const dueA = makeMemory('prediction', 'Trial lifts activation.', NOW - 1000, [ev('e-a1'), ev('e-a2')]);

    const [item] = selectDueMemories(env.db, { now: NOW });
    expect(item!.memoryId).toBe(dueA);
    expect(item!.evidenceCount).toBe(2);
    // Evidence in the org-visible general channel → org scope.
    expect(item!.scopeType).toBe('org');
    expect(item!.scopeKey).toBeNull();
  });

  it('bounds the result to the requested limit', () => {
    for (let i = 0; i < 5; i++) makeMemory('prediction', `pred ${i}`, NOW - i, [ev('e-a1')]);
    const due = selectDueMemories(env.db, { now: NOW, limit: 2 });
    expect(due).toHaveLength(2);
    // Most-overdue first.
    expect(due[0]!.reviewAfterMs).toBeLessThan(due[1]!.reviewAfterMs);
  });

  it('returns nothing when no memory is due', () => {
    makeMemory('prediction', 'future bet', NOW + 5000, [ev('e-a1')]);
    expect(selectDueMemories(env.db, { now: NOW })).toEqual([]);
  });
});

describe('due-memory staleness horizon — Section 12.4', () => {
  const HORIZON = 45 * 86_400_000;
  const ANCIENT = NOW - HORIZON - 1000;

  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(CHANNEL);
    addMessage('e-a1', 'recent evidence');
    addMessage('e-old', 'ancient evidence', ANCIENT);
  });

  function setReviewDate(id: string, reviewAfterMs: number): void {
    env.db.prepare('UPDATE memories SET review_after_ms = ? WHERE id = ?').run(reviewAfterMs, id);
  }

  it('excludes memories past the horizon from both selectors', () => {
    // Extracted recently from an old conversation: the memory row is fresh, but
    // the newest evidence message and the review date both sit past the horizon.
    const stale = makeMemory('prediction', 'Ancient bet.', NOW - 1000, [ev('e-old')]);
    setReviewDate(stale, ANCIENT);
    const fresh = makeMemory('assumption', 'Recent item.', NOW - 1000, [ev('e-a1')]);

    const options = { now: NOW, stalenessHorizonMs: HORIZON };
    expect(selectDueMemories(env.db, options).map((d) => d.memoryId)).toEqual([fresh]);
    expect(selectDueMemoriesForDispatch(env.db, options).map((d) => d.memoryId)).toEqual([fresh]);
  });

  it('keeps a past-horizon review date alive when its newest evidence is recent', () => {
    const active = makeMemory('prediction', 'Old date, live thread.', NOW - 1000, [ev('e-old'), ev('e-a1')]);
    setReviewDate(active, ANCIENT);

    const options = { now: NOW, stalenessHorizonMs: HORIZON };
    expect(selectDueMemories(env.db, options).map((d) => d.memoryId)).toEqual([active]);
    expect(selectDueMemoriesForDispatch(env.db, options).map((d) => d.memoryId)).toEqual([active]);
  });

  it('keeps a recently due review date alive despite old evidence', () => {
    // A review date the model deliberately set for now (for example a commitment
    // recorded in May and due in September) stays reviewable.
    const dueNow = makeMemory('decision', 'Old promise, review due now.', NOW - 1000, [ev('e-old')]);

    const options = { now: NOW, stalenessHorizonMs: HORIZON };
    expect(selectDueMemories(env.db, options).map((d) => d.memoryId)).toEqual([dueNow]);
    expect(selectDueMemoriesForDispatch(env.db, options).map((d) => d.memoryId)).toEqual([dueNow]);
  });

  it('selects everything due when the horizon is disabled', () => {
    const stale = makeMemory('prediction', 'Ancient bet.', NOW - 1000, [ev('e-old')]);
    setReviewDate(stale, ANCIENT);

    expect(selectDueMemories(env.db, { now: NOW }).map((d) => d.memoryId)).toEqual([stale]);
    expect(
      selectDueMemories(env.db, { now: NOW, stalenessHorizonMs: 0 }).map((d) => d.memoryId),
    ).toEqual([stale]);
    expect(
      selectDueMemoriesForDispatch(env.db, { now: NOW, stalenessHorizonMs: 0 }).map((d) => d.memoryId),
    ).toEqual([stale]);
  });
});

describe('due-review scheduling', () => {
  beforeEach(() => {
    env = createTestDb();
    seedIdentity(env.db);
    env.db.prepare("UPDATE channels SET visibility_class = 'org' WHERE id = ?").run(CHANNEL);
    addMessage('e-a1', 'evidence');
  });

  it('enqueues a review_due_memories job when material is due', () => {
    makeMemory('prediction', 'A due bet.', NOW - 1000, [ev('e-a1')]);
    const res = scheduleDueReview(env.db, { now: NOW });

    expect(res.dueCount).toBe(1);
    expect(res.enqueued).toBe(true);
    expect(res.jobId).toBeTruthy();

    const jobs = dueJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.unique_key).toBe(DUE_REVIEW_UNIQUE_KEY);
    expect(jobs[0]!.status).toBe('queued');
    expect(JSON.parse(jobs[0]!.payload_json).sinceMs).toBe(NOW);
  });

  it('collapses repeated ticks onto a single active job (no duplicate work)', () => {
    makeMemory('prediction', 'A due bet.', NOW - 1000, [ev('e-a1')]);

    const first = scheduleDueReview(env.db, { now: NOW });
    expect(first.enqueued).toBe(true);

    // Second tick while the first is still queued/running.
    const second = scheduleDueReview(env.db, { now: NOW + 1 });
    expect(second.dueCount).toBe(1);
    expect(second.enqueued).toBe(false);
    expect(second.jobId).toBeUndefined();

    expect(dueJobs()).toHaveLength(1);
  });

  it('enqueues nothing when no memory is due', () => {
    makeMemory('prediction', 'future bet', NOW + 5000, [ev('e-a1')]);
    const res = scheduleDueReview(env.db, { now: NOW });
    expect(res).toEqual({ dueCount: 0, enqueued: false });
    expect(dueJobs()).toHaveLength(0);
  });
});
