import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedIdentity, type TestDb } from '../helpers/db.js';
import { upsertMessageCreate } from '../../src/db/repositories/messages.js';
import { upsertUser } from '../../src/db/repositories/users.js';
import { createMemory, getMemory } from '../../src/memory/repository.js';
import { searchMemories } from '../../src/memory/search.js';
import { searchMessages, type RetrievalGrant } from '../../src/db/repositories/message-search.js';
import { upsertChannel } from '../../src/db/repositories/channels.js';
import { grantForSecureReview } from '../../src/production-runtime.js';
import {
  applyMemoryProposals,
  type AgentMemoryProposal,
  type ApplyMemoryProposalsDeps,
} from '../../src/agent/memory-policy.js';

/**
 * Evidence and memory-proposal host validation (Sections 7, 12.2, 12.3, 23).
 *
 * Acceptance: invented, invisible, deleted, or insufficient evidence produces no
 * memory mutation and an auditable rejection. The host — not the model — owns
 * scope and exposure.
 */

const GUILD = '100000000000000001';
const CHANNEL = '100000000000000002'; // seeded, restricted
const ALICE = '100000000000000003'; // seeded human
const BOB = '100000000000000010';
const NOW = 1_700_000_001_000;

/** A grant that permits the seeded restricted channel plus org channels. */
const GRANT: RetrievalGrant = {
  includeOrgMessages: true, includeOrgMemories: true,
  includeReviewOnly: false,
  channelIds: [CHANNEL],
};

let env: TestDb;

beforeEach(() => {
  env = createTestDb();
  exposedMemoryIds = new Set<string>();
  seedIdentity(env.db);
  upsertUser(env.db, {
    id: BOB,
    username: 'bob',
    globalName: 'Bob',
    isBot: false,
    firstSeenAtMs: NOW,
    lastSeenAtMs: NOW,
    rawJson: null,
  });
});
afterEach(() => env.cleanup());

function seedMessage(id: string, channel: string, content = 'Adopt the onboarding trial.'): void {
  upsertMessageCreate(env.db, {
    id,
    guildId: GUILD,
    channelId: channel,
    authorId: ALICE,
    authorDisplayName: 'Alice',
    content,
    createdAtMs: NOW,
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
    ingestedAtMs: NOW,
    updatedAtMs: NOW,
  });
}

/** Seed a second restricted channel so exposure/visibility can be distinguished. */
function seedRestrictedChannel(id: string): void {
  seedPolicyChannel(id, 'restricted');
}

function seedPolicyChannel(
  id: string,
  visibility: 'org' | 'restricted',
  options: { parentId?: string; isThread?: boolean } = {},
): void {
  upsertChannel(env.db, {
    id,
    guildId: GUILD,
    parentId: options.parentId ?? null,
    type: options.isThread ? 11 : 0,
    name: id,
    topic: null,
    position: null,
    isThread: options.isThread ?? false,
    isArchived: false,
    isLocked: false,
    ingestEnabled: true,
    visibilityClass: visibility,
    allowInterventions: false,
    permissionFingerprint: null,
    lastMessageId: null,
    discoveredAtMs: NOW,
    updatedAtMs: NOW,
    rawJson: null,
  });
}

let exposedMemoryIds = new Set<string>();

function makeDeps(exposedChannelIds: ReadonlySet<string>, grant: RetrievalGrant = GRANT): ApplyMemoryProposalsDeps {
  const exposedMessageIds = new Set((env.db.prepare(
    `SELECT id FROM messages WHERE channel_id IN (${[...exposedChannelIds].map(() => '?').join(',') || "''"})`,
  ).all(...exposedChannelIds) as Array<{ id: string }>).map((row) => row.id));
  return {
    db: env.db,
    grant,
    guildId: GUILD,
    runId: 'run-1',
    now: NOW,
    exposedChannelIds,
    exposedMessageIds,
    exposedMemoryIds,
  };
}

function createProposal(over: Partial<AgentMemoryProposal> & { action: AgentMemoryProposal['action'] }): AgentMemoryProposal {
  const evidenceMessageIds = over.evidenceMessageIds ?? ['m1'];
  return {
    type: 'decision',
    statement: 'Adopt the onboarding trial.',
    confidence: 0.8,
    importance: 0.7,
    evidenceMessageIds,
    evidenceQuotes: evidenceMessageIds.map((messageId) => ({
      messageId,
      quote: (env.db.prepare('SELECT content FROM messages WHERE id=?').get(messageId) as { content: string } | undefined)?.content ?? 'unsupported',
    })),
    durability: 'project',
    durabilityReason: 'This affects future project work.',
    ...over,
  };
}

/** Seed a target memory to act on with lifecycle proposals. Returns its id. */
function seedTargetMemory(evidenceId = 'm1'): string {
  seedMessage(evidenceId, CHANNEL, 'we decided');
  const id = createMemory(env.db, GRANT, {
    guildId: GUILD,
    type: 'decision',
    statement: 'Earlier decision.',
    confidence: 0.5,
    importance: 0.5,
    evidence: [{ messageId: evidenceId, stance: 'origin' }],
    createdByRunId: 'run-0',
    now: NOW,
  });
  exposedMemoryIds.add(id);
  return id;
}

describe('applyMemoryProposals — accepted proposals mutate memory', () => {
  it('creates a memory from valid, exposed evidence', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toHaveLength(0);
    const id = out.applied[0]!.memoryId!;
    const mem = getMemory(env.db, id);
    expect(mem).toBeDefined();
    expect(mem!.type).toBe('decision');
    expect(mem!.created_by_run_id).toBe('run-1');
  });

  it('applies confirm/update/resolve/invalidate/supersede against an existing target', () => {
    const targetId = seedTargetMemory('m1');
    const exposed = new Set([CHANNEL]);

    // confirm
    seedMessage('m2', CHANNEL, 'confirms');
    let out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'confirm', existingMemoryId: targetId, evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.applied[0]!.memoryId).toBe(targetId);

    // update
    seedMessage('m3', CHANNEL, 'Updated statement.');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({
        action: 'update',
        existingMemoryId: targetId,
        statement: 'Updated statement.',
        confidence: 0.9,
        evidenceMessageIds: ['m3'],
      }),
    ]);
    expect(out.applied[0]!.memoryId).toBe(targetId);
    expect(getMemory(env.db, targetId)!.confidence).toBe(0.9);

    // resolve
    seedMessage('m4', CHANNEL, 'resolves');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'resolve', existingMemoryId: targetId, evidenceMessageIds: ['m4'] }),
    ]);
    expect(out.applied[0]!.accepted).toBe(true);
    expect(getMemory(env.db, targetId)!.status).toBe('resolved');

    // re-seed an active target for invalidate
    const t2 = seedTargetMemory('m5');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({ action: 'invalidate', existingMemoryId: t2, evidenceMessageIds: ['m5'] }),
    ]);
    expect(getMemory(env.db, t2)!.status).toBe('invalidated');

    // supersede
    const t3 = seedTargetMemory('m6');
    out = applyMemoryProposals(makeDeps(exposed), [
      createProposal({
        action: 'supersede',
        existingMemoryId: t3,
        statement: 'We decided.',
        evidenceMessageIds: ['m6'],
      }),
    ]);
    expect(out.applied[0]!.memoryId).not.toBe(t3);
    expect(getMemory(env.db, t3)!.status).toBe('superseded');
  });
});

describe('applyMemoryProposals — rejected evidence produces no mutation', () => {
  it('rejects an UPDATE that could copy restricted run content into an org memory', () => {
    const orgChannel = '100000000000000041';
    seedRestrictedChannel(orgChannel);
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(orgChannel);
    seedMessage('org-origin', orgChannel, 'The public rollout remains unchanged.');
    seedMessage('restricted-update-source', CHANNEL, 'The restricted launch condition changed.');
    seedMessage('org-update-citation', orgChannel, 'Public follow-up evidence.');
    const targetId = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'The public rollout remains unchanged.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: 'org-origin', stance: 'origin' }],
      now: NOW,
    });
    exposedMemoryIds.add(targetId);

    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL, orgChannel])), [
      createProposal({
        action: 'update',
        existingMemoryId: targetId,
        statement: 'The restricted launch condition changed.',
        evidenceMessageIds: ['org-update-citation'],
      }),
    ]);

    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
    expect(getMemory(env.db, targetId)?.statement).toBe('The public rollout remains unchanged.');
  });

  it('rejects an org memory created after a restricted memory was exposed', () => {
    const orgChannel = '100000000000000040';
    seedRestrictedChannel(orgChannel);
    env.db.prepare("UPDATE channels SET visibility_class='org' WHERE id=?").run(orgChannel);
    seedMessage('restricted-source', CHANNEL, 'restricted source');
    seedMessage('org-citation', orgChannel, 'public citation');
    const restrictedMemory = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Restricted statement.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: 'restricted-source', stance: 'origin' }],
      now: NOW,
    });
    exposedMemoryIds.add(restrictedMemory);

    const out = applyMemoryProposals(makeDeps(new Set([orgChannel])), [
      createProposal({ action: 'create', statement: 'Restricted paraphrase.', evidenceMessageIds: ['org-citation'] }),
    ]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
  });

  it('rejects invented evidence and creates no memory', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1', 'invented-id'] }),
    ]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toBe('invented_evidence');
    expect(out.rejected[0]!.detail).toContain('invented-id');
    // No memory row was created.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects deleted evidence and creates no memory', () => {
    seedMessage('m1', CHANNEL);
    env.db.prepare('UPDATE messages SET deleted_at_ms = ? WHERE id = ?').run(NOW, 'm1');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('deleted_evidence');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects evidence the model did not see this run (a guessed-but-real id)', () => {
    // A second restricted channel whose message is real and visible under the
    // grant, but was NOT exposed to the model this run.
    seedRestrictedChannel('100000000000000020');
    seedMessage('m-secret', '100000000000000020', 'hidden context');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m-secret'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('evidence_not_exposed');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects invisible (out-of-scope) evidence via the repository scope check', () => {
    // Evidence that exists, is undeleted, and is in the exposure set, but whose
    // channel the grant does not permit. The policy pre-checks pass; the
    // repository's scope authority rejects it. (In production exposure is a
    // subset of grant-visibility; this test isolates the repository gate.)
    seedRestrictedChannel('100000000000000030');
    seedMessage('m-oos', '100000000000000030', 'out of scope');
    const out = applyMemoryProposals(
      makeDeps(
        new Set([CHANNEL, '100000000000000030']),
        { includeOrgMessages: true, includeOrgMemories: true, includeReviewOnly: false, channelIds: [CHANNEL] }, // grant excludes 030
      ),
      [createProposal({ action: 'create', evidenceMessageIds: ['m-oos'] })],
    );
    expect(out.rejected[0]!.reason).toBe('evidence_out_of_scope');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('rejects a proposal with no evidence', () => {
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: [] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('no_evidence');
  });
});

describe('applyMemoryProposals — restricted citation anchors', () => {
  const PARENT = '100000000000000060';
  const THREAD = '100000000000000061';
  const SIBLING = '100000000000000062';
  const ORG_MESSAGE = 'mixed-org-message';
  const THREAD_MESSAGE = 'mixed-thread-message';

  function seedMixedThreadFixture() {
    seedPolicyChannel(PARENT, 'org');
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedPolicyChannel(SIBLING, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(ORG_MESSAGE, PARENT, 'Project launch timeline was reviewed.');
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    seedMessage('mixed-sibling-message', SIBLING, 'Project launch credential is raven.');
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    return {
      grant,
      exposedChannelIds: new Set(results.map((row) => row.channelId)),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
    };
  }

  function seedOrgTarget(grant: RetrievalGrant): string {
    const id = createMemory(env.db, grant, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Project launch timeline was reviewed.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: ORG_MESSAGE, stance: 'origin' }],
      createdByRunId: 'run-0',
      now: NOW,
    });
    exposedMemoryIds.add(id);
    return id;
  }

  function mixedDeps(fixture: ReturnType<typeof seedMixedThreadFixture>): ApplyMemoryProposalsDeps {
    return {
      db: env.db,
      grant: fixture.grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: fixture.exposedChannelIds,
      exposedMessageIds: fixture.exposedMessageIds,
      exposedMemoryIds,
    };
  }

  it.each(['update', 'supersede'] as const)(
    'rejects org-parent evidence and accepts restricted-thread evidence for %s',
    (action) => {
      const fixture = seedMixedThreadFixture();
      const targetId = seedOrgTarget(fixture.grant);
      const fail = applyMemoryProposals(mixedDeps(fixture), [createProposal({
        action,
        existingMemoryId: targetId,
        statement: 'Project launch credential is raven.',
        evidenceMessageIds: [ORG_MESSAGE],
      })]);
      expect(fail.applied).toHaveLength(0);
      expect(fail.rejected[0]?.reason).toBe('evidence_out_of_scope');
      expect(getMemory(env.db, targetId)?.statement).toBe('Project launch timeline was reviewed.');

      const pass = applyMemoryProposals(mixedDeps(fixture), [createProposal({
        action,
        existingMemoryId: targetId,
        statement: 'Project launch credential is raven.',
        evidenceMessageIds: [THREAD_MESSAGE],
      })]);
      expect(pass.applied).toHaveLength(1);
      const memoryId = pass.applied[0]!.memoryId!;
      expect(getMemory(env.db, memoryId)).toMatchObject({ scope_type: 'channel', scope_key: PARENT });
      expect(searchMemories(env.db, {
        includeOrgMessages: true,
        includeOrgMemories: true,
        includeReviewOnly: false,
        channelIds: [],
      }, { query: 'credential raven', now: NOW + 2 })).toEqual([]);
    },
  );

  it('rejects an org-parent citation for create after restricted thread exposure', () => {
    const fixture = seedMixedThreadFixture();
    const out = applyMemoryProposals(mixedDeps(fixture), [createProposal({
      action: 'create',
      statement: 'Project launch credential is raven.',
      evidenceMessageIds: [ORG_MESSAGE],
    })]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
  });

  it('rejects org evidence when a restricted channel-scoped memory was exposed', () => {
    const fixture = seedMixedThreadFixture();
    const restrictedMemoryId = createMemory(env.db, fixture.grant, {
      guildId: GUILD,
      type: 'fact',
      statement: 'Project launch credential is raven.',
      confidence: 0.8,
      importance: 0.8,
      evidence: [{ messageId: THREAD_MESSAGE, stance: 'origin' }],
      createdByRunId: 'run-0',
      now: NOW,
    });
    const targetId = seedOrgTarget(fixture.grant);
    exposedMemoryIds.add(restrictedMemoryId);
    const out = applyMemoryProposals({
      ...mixedDeps(fixture),
      exposedChannelIds: new Set([PARENT]),
      exposedMessageIds: new Set([ORG_MESSAGE]),
    }, [createProposal({
      action: 'update',
      existingMemoryId: targetId,
      statement: 'Project launch credential is raven.',
      evidenceMessageIds: [ORG_MESSAGE],
    })]);
    expect(out.applied).toHaveLength(0);
    expect(out.rejected[0]?.reason).toBe('evidence_out_of_scope');
    expect(getMemory(env.db, targetId)?.statement).toBe('Project launch timeline was reviewed.');
  });

  it.each([
    { parentVisibility: 'org' as const, citation: 'mixed-sibling-message' },
    { parentVisibility: 'restricted' as const, citation: 'restricted-parent-message' },
  ])('accepts restricted family evidence with a shared anchor: $parentVisibility parent', ({ parentVisibility, citation }) => {
    seedPolicyChannel(PARENT, parentVisibility);
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedPolicyChannel(SIBLING, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    if (parentVisibility === 'restricted') {
      seedMessage(citation, PARENT, 'Project launch credential is raven.');
    } else {
      seedMessage(citation, SIBLING, 'Project launch credential is raven.');
    }
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    const out = applyMemoryProposals({
      db: env.db,
      grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: new Set(results.map((row) => row.channelId)),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
      exposedMemoryIds,
    }, [createProposal({ action: 'create', evidenceMessageIds: [citation], statement: 'Project launch credential is raven.' })]);
    expect(out.rejected).toHaveLength(0);
    expect(getMemory(env.db, out.applied[0]!.memoryId!)).toMatchObject({
      scope_type: 'channel',
      scope_key: PARENT,
    });
  });

  it('accepts a restricted child-thread citation for its exposed restricted parent anchor', () => {
    seedPolicyChannel(PARENT, 'restricted');
    seedPolicyChannel(THREAD, 'restricted', { parentId: PARENT, isThread: true });
    seedMessage(THREAD_MESSAGE, THREAD, 'Project launch credential is raven.');
    const grant = grantForSecureReview(env.db, ['org', 'restricted']);
    const results = searchMessages(env.db, grant, { query: 'project launch', limit: 20, now: NOW });
    const out = applyMemoryProposals({
      db: env.db,
      grant,
      guildId: GUILD,
      runId: 'run-1',
      now: NOW + 1,
      exposedChannelIds: new Set([PARENT, ...results.map((row) => row.channelId)]),
      exposedMessageIds: new Set(results.map((row) => row.messageId)),
      exposedMemoryIds,
    }, [createProposal({
      action: 'create',
      evidenceMessageIds: [THREAD_MESSAGE],
      statement: 'Project launch credential is raven.',
    })]);
    expect(out.rejected).toHaveLength(0);
    expect(getMemory(env.db, out.applied[0]!.memoryId!)).toMatchObject({
      scope_type: 'channel',
      scope_key: PARENT,
    });
  });
});

describe('applyMemoryProposals — lifecycle target and field validation', () => {
  it('rejects a lifecycle action with no existingMemoryId', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'confirm', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('missing_target');
  });

  it('rejects a lifecycle action whose target does not exist', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'update', existingMemoryId: 'mem-nope', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.rejected[0]!.reason).toBe('target_not_found');
  });

  it('rejects a nonexistent owner', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], ownerUserId: 'ghost-user' }),
    ]);
    expect(out.rejected[0]!.reason).toBe('owner_not_found');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });

  it('accepts a real owner', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], ownerUserId: BOB }),
    ]);
    expect(out.applied).toHaveLength(1);
  });

  it('rejects an invalid reviewAt', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], reviewAt: 'not-a-date' }),
    ]);
    expect(out.rejected[0]!.reason).toBe('invalid_review_at');
  });

  it('rejects a malformed proposal (confidence out of range)', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'], confidence: 1.5 }),
    ]);
    expect(out.rejected[0]!.reason).toBe('malformed_proposal');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
  });
});

describe('applyMemoryProposals — batch isolation and auditing', () => {
  it('applies valid proposals and retains rejections in the same batch', () => {
    seedMessage('m1', CHANNEL, 'First valid.');
    seedMessage('m2', CHANNEL, 'Second valid.');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', statement: 'First valid.', evidenceMessageIds: ['m1'] }),
      createProposal({ action: 'create', evidenceMessageIds: ['invented'] }),
      createProposal({ action: 'create', statement: 'Second valid.', evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.total).toBe(3);
    expect(out.applied).toHaveLength(2);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.index).toBe(1); // the middle proposal
    expect(out.rejected[0]!.reason).toBe('invented_evidence');
    // Two memories were created despite the middle rejection.
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(2);
  });

  it('records the action and cited evidence on every outcome for audit', () => {
    seedMessage('m1', CHANNEL);
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1', 'm2'] }), // m2 invented
    ]);
    const r = out.rejected[0]!;
    expect(r.action).toBe('create');
    expect(r.evidenceMessageIds).toEqual(['m1', 'm2']);
    expect(r.reason).toBeDefined();
    expect(typeof r.detail).toBe('string');
    expect(r.detail).not.toContain('msg'); // no message content leaks into the audit detail
  });

  it('an episode-channel message is always exposed (evidence grounded in the transcript)', () => {
    seedMessage('m1', CHANNEL);
    // Even with an empty provenance set, the episode channel itself is exposed.
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m1'] }),
    ]);
    expect(out.applied).toHaveLength(1);
  });
});

describe('applyMemoryProposals — memory quality hardening', () => {
  it('rejects a real message from the same exposed channel when that exact message was not exposed', () => {
    seedMessage('m1', CHANNEL, 'we decided to use passkeys');
    seedMessage('m-unseen', CHANNEL, 'secret same-channel detail');
    const deps = makeDeps(new Set([CHANNEL]));
    deps.exposedMessageIds = new Set(['m1']);
    const out = applyMemoryProposals(deps, [
      createProposal({ action: 'create', evidenceMessageIds: ['m-unseen'] }),
    ]);
    expect(out.rejected[0]?.reason).toBe('evidence_not_exposed');
  });

  it('rejects a supporting quote that is not actually present in its cited message', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for the admin console.');
    const proposal = createProposal({ action: 'create', evidenceMessageIds: ['m1'] });
    proposal.evidenceQuotes = [{ messageId: 'm1', quote: 'for the customer dashboard' }];
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [proposal]);
    expect(out.rejected[0]?.reason).toBe('unsupported_evidence_quote');
  });

  it('rejects an unsupported material clause even when its cited quote is real', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for the admin console.');
    const proposal = createProposal({
      action: 'create',
      statement: 'Use passkeys for the admin console and validate Test Org specifications.',
      evidenceMessageIds: ['m1'],
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [proposal]);
    expect(out.rejected[0]?.reason).toBe('unsupported_statement_clause');
  });

  it('rejects transient and low-importance creates before persistence', () => {
    seedMessage('m1', CHANNEL, 'the deploy is at 42 percent');
    const deps = { ...makeDeps(new Set([CHANNEL])), minimumImportance: 0.6 };
    const transient = createProposal({ action: 'create', durability: 'transient' });
    const low = createProposal({ action: 'create', statement: 'Track deploy percent.', importance: 0.2 });
    const out = applyMemoryProposals(deps, [transient, low]);
    expect(out.rejected.map((item) => item.reason)).toEqual(['transient_memory', 'below_minimum_importance']);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
  });

  it('confirms an exact active duplicate instead of creating another memory row', () => {
    seedMessage('m1', CHANNEL, 'Adopt the onboarding trial.');
    const existing = createMemory(env.db, GRANT, {
      guildId: GUILD, type: 'decision', statement: 'Adopt the onboarding trial.',
      confidence: 0.8, importance: 0.7,
      evidence: [{ messageId: 'm1', stance: 'origin' }], now: NOW - 1,
    });
    seedMessage('m2', CHANNEL, 'Adopt the onboarding trial.');
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({ action: 'create', evidenceMessageIds: ['m2'] }),
    ]);
    expect(out.applied[0]?.memoryId).toBe(existing);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
  });

  it('confirms a reworded same-type claim with substantially overlapping evidence', () => {
    seedMessage('m1', CHANNEL, 'Stealth Browser is not offered as a one-off line item or based on usage. It is offered exclusively to enterprise customers except POCs and trials.');
    const existing = createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'constraint',
      statement: 'Stealth Browser is offered only to enterprise accounts, except trials; there is no usage billing.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: 'm1', stance: 'origin' }],
      now: NOW - 1,
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({
        action: 'create',
        type: 'constraint',
        statement: 'Stealth Browser is not offered based on usage and is exclusive to enterprise customers except POCs and trials.',
        evidenceMessageIds: ['m1'],
      }),
    ]);
    expect(out.applied[0]?.memoryId).toBe(existing);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 1 });
  });

  it('keeps lexically distinct same-type claims from one source separate', () => {
    seedMessage('m1', CHANNEL, 'Adopt passkeys for admins. Keep the existing billing plan for customers.');
    createMemory(env.db, GRANT, {
      guildId: GUILD,
      type: 'decision',
      statement: 'Adopt passkeys for administrator authentication.',
      confidence: 0.9,
      importance: 0.8,
      evidence: [{ messageId: 'm1', stance: 'origin' }],
      now: NOW - 1,
    });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [
      createProposal({
        action: 'create',
        statement: 'Keep the existing billing plan for customers.',
        evidenceMessageIds: ['m1'],
      }),
    ]);
    expect(out.applied).toHaveLength(1);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 2 });
  });

  it('requires overlapping same-evidence proposals to justify separate canonical records', () => {
    seedMessage('m1', CHANNEL, 'Use passkeys for admin authentication and document the rollout.');
    const first = createProposal({ action: 'create', statement: 'Use passkeys for admin authentication.' });
    const second = createProposal({ action: 'create', type: 'risk', statement: 'Admin authentication with passkeys needs rollout documentation.' });
    const out = applyMemoryProposals(makeDeps(new Set([CHANNEL])), [first, second]);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected[0]?.reason).toBe('duplicate_memory');
  });
});
