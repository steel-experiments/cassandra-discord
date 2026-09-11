import { describe, it, expect } from 'vitest';
import {
  pinnedTargetForRunType,
  evaluateProvenanceGate,
  resolveProvenanceScopes,
  type ProvenanceScopeEntry,
  type TargetScope,
} from '../../src/agent/policy.js';
import type { RetrievalProvenance } from '../../src/agent/run-context.js';
import type { VisibilityClass } from '../../src/db/repositories/channels.js';

/**
 * Pinned-target and retrieval-provenance gate (Sections 7.3, 7.4, 23, 24.2,
 * 46.3).
 *
 * Acceptance: privacy fixtures reject target changes and restricted-content
 * paraphrases even when no restricted evidence ID is cited.
 */

const ORG = '100000000000000001';
const RESTRICTED_A = '100000000000000010';
const RESTRICTED_B = '100000000000000011';
const RESTRICTED_A_THREAD = '100000000000000012';
const REVIEW = '100000000000000099';

function channel(id: string, visibility: VisibilityClass): ProvenanceScopeEntry {
  return { kind: 'channel', channelId: id, visibility };
}
function memory(channelId: string | null, visibility: VisibilityClass | undefined): ProvenanceScopeEntry {
  return { kind: 'memory', channelId, visibility };
}

const orgTarget: TargetScope = { channelId: ORG, visibility: 'org', isSecureReview: false };
const restrictedTargetA: TargetScope = {
  channelId: RESTRICTED_A,
  visibility: 'restricted',
  isSecureReview: false,
};
const reviewTarget: TargetScope = {
  channelId: REVIEW,
  visibility: 'review_only',
  isSecureReview: true,
};

function gate(opts: {
  pinned?: string;
  proposed?: string;
  target: TargetScope;
  provenance: ProvenanceScopeEntry[];
}) {
  return evaluateProvenanceGate({
    pinnedTargetChannelId: opts.pinned ?? opts.target.channelId,
    proposedTargetChannelId: opts.proposed ?? opts.target.channelId,
    target: opts.target,
    provenance: opts.provenance,
  });
}

describe('pinnedTargetForRunType — Section 7.4 check 1', () => {
  const ctx = { episodeChannelId: 'ep', directAnswerChannelId: 'da', reviewChannelId: REVIEW };
  it('pins the episode conversation channel for episode reviews', () => {
    expect(pinnedTargetForRunType('episode', ctx)).toBe('ep');
  });
  it('pins the current channel for direct answers', () => {
    expect(pinnedTargetForRunType('direct_answer', ctx)).toBe('da');
  });
  it('pins the secure review channel for scheduled reviews', () => {
    expect(pinnedTargetForRunType('scheduled_review', ctx)).toBe(REVIEW);
  });
});

describe('evaluateProvenanceGate — target change', () => {
  it('rejects a proposal that retargets away from the host-pinned target (case 6)', () => {
    const res = gate({
      pinned: RESTRICTED_A,
      proposed: ORG,
      target: restrictedTargetA,
      provenance: [channel(RESTRICTED_A, 'restricted')],
    });
    expect(res.outcome).toBe('reject');
    expect(res.reasons[0]).toContain(ORG);
    expect(res.reasons[0]).toContain(RESTRICTED_A);
  });
});

describe('evaluateProvenanceGate — scope leakage', () => {
  it('allows an org target that only retrieved org content', () => {
    expect(
      gate({ target: orgTarget, provenance: [channel(ORG, 'org'), memory(null, 'org')] }).outcome,
    ).toBe('allow');
  });

  it('forces review when an org-targeted run retrieved restricted content (case 4 paraphrase)', () => {
    // The proposal may cite nothing restricted — the gate keys on provenance.
    const res = gate({ target: orgTarget, provenance: [channel(ORG, 'org'), channel(RESTRICTED_A, 'restricted')] });
    expect(res.outcome).toBe('force_review');
    expect(res.reasons.some((r) => r.includes('restricted'))).toBe(true);
  });

  it('forces review when restricted content was paraphrased with no cited evidence at all', () => {
    // No citation information is even part of the gate input; provenance alone decides.
    const res = gate({ target: orgTarget, provenance: [memory(RESTRICTED_A, 'restricted')] });
    expect(res.outcome).toBe('force_review');
  });

  it('allows a restricted target that retrieved its own channel content', () => {
    expect(
      gate({
        target: restrictedTargetA,
        provenance: [channel(RESTRICTED_A, 'restricted'), memory(null, 'org')],
      }).outcome,
    ).toBe('allow');
  });

  it('treats a restricted thread and its parent as the same scope anchor', () => {
    const threadTarget: TargetScope = {
      channelId: RESTRICTED_A_THREAD,
      scopeChannelId: RESTRICTED_A,
      visibility: 'restricted',
      isSecureReview: false,
    };
    expect(gate({
      target: threadTarget,
      provenance: [channel(RESTRICTED_A, 'restricted'), memory(RESTRICTED_A, 'restricted')],
    }).outcome).toBe('allow');
    expect(gate({
      target: threadTarget,
      provenance: [channel(RESTRICTED_B, 'restricted')],
    }).outcome).toBe('force_review');
  });

  it('forces review when a restricted target retrieved a different restricted channel (case 2 mixed)', () => {
    const res = gate({
      target: restrictedTargetA,
      provenance: [channel(RESTRICTED_A, 'restricted'), channel(RESTRICTED_B, 'restricted')],
    });
    expect(res.outcome).toBe('force_review');
    expect(res.reasons.some((r) => r.includes(RESTRICTED_B))).toBe(true);
  });

  it('forces review when a restricted target retrieved review-only content', () => {
    expect(
      gate({
        target: restrictedTargetA,
        provenance: [channel(RESTRICTED_A, 'restricted'), memory(null, 'review_only')],
      }).outcome,
    ).toBe('force_review');
  });

  it('forces review when an org target retrieved review-only content', () => {
    expect(gate({ target: orgTarget, provenance: [memory(null, 'review_only')] }).outcome).toBe(
      'force_review',
    );
  });

  it('allows the secure review target to receive any scope, including review-only', () => {
    expect(
      gate({
        target: reviewTarget,
        provenance: [
          channel(RESTRICTED_A, 'restricted'),
          channel(RESTRICTED_B, 'restricted'),
          memory(null, 'review_only'),
        ],
      }).outcome,
    ).toBe('allow');
  });

  it('still fails closed in secure review when source visibility is unresolvable', () => {
    expect(
      gate({ target: reviewTarget, provenance: [channel('999000000000000000', undefined)] }).outcome,
    ).toBe('force_review');
  });

  it('fails closed (force_review) when a channel visibility is unresolvable', () => {
    expect(
      gate({ target: orgTarget, provenance: [channel('999000000000000000', undefined)] }).outcome,
    ).toBe('force_review');
  });

  it('never includes message content in reasons (redacted)', () => {
    const res = gate({ target: orgTarget, provenance: [channel(RESTRICTED_A, 'restricted')] });
    for (const r of res.reasons) {
      expect(r).toMatch(/scope|target|permitted|restricted|review/i);
    }
  });
});

describe('resolveProvenanceScopes', () => {
  const lookups = {
    channelVisibility: (id: string): VisibilityClass | undefined => {
      const map: Record<string, VisibilityClass> = {
        [ORG]: 'org',
        [RESTRICTED_A]: 'restricted',
        [RESTRICTED_A_THREAD]: 'restricted',
        [REVIEW]: 'review_only',
      };
      return map[id];
    },
    channelScopeId: (id: string) => id === RESTRICTED_A_THREAD ? RESTRICTED_A : id,
  };

  it('resolves channel provenance via the lookup', () => {
    const prov: RetrievalProvenance = {
      channels: [
        { channelId: ORG, source: 'message_search' },
        { channelId: RESTRICTED_A, source: 'message_context' },
      ],
      memoryScopes: [],
      charsExposed: 0,
      charBudget: 60_000,
    };
    const entries = resolveProvenanceScopes(prov, lookups);
    expect(entries).toEqual([
      { kind: 'channel', channelId: ORG, visibility: 'org' },
      { kind: 'channel', channelId: RESTRICTED_A, visibility: 'restricted' },
    ]);
  });

  it('normalizes restricted thread provenance to its parent scope anchor', () => {
    const prov: RetrievalProvenance = {
      channels: [{ channelId: RESTRICTED_A_THREAD, source: 'message_context' }],
      messageIds: ['thread-message'],
      memoryScopes: [],
      memoryIds: [],
      charsExposed: 10,
      charBudget: 60_000,
    };
    expect(resolveProvenanceScopes(prov, lookups)).toEqual([
      { kind: 'channel', channelId: RESTRICTED_A, visibility: 'restricted' },
    ]);
  });

  it('maps memory scope types to effective visibility', () => {
    const prov: RetrievalProvenance = {
      channels: [],
      memoryScopes: [
        { scopeType: 'org', scopeKey: null, source: 'memory_search' },
        { scopeType: 'channel', scopeKey: RESTRICTED_A, source: 'memory_search' },
        { scopeType: 'review_only', scopeKey: null, source: 'memory_search' },
        { scopeType: 'unknown_type', scopeKey: null, source: 'memory_search' },
      ],
      charsExposed: 0,
      charBudget: 60_000,
    };
    const entries = resolveProvenanceScopes(prov, lookups);
    expect(entries.map((e) => [e.visibility, e.channelId])).toEqual([
      ['org', null],
      ['restricted', RESTRICTED_A],
      ['review_only', null],
      [undefined, null],
    ]);
  });

  it('keeps channel-scoped provenance restricted when its canonical anchor is org', () => {
    const prov: RetrievalProvenance = {
      channels: [],
      memoryScopes: [{ scopeType: 'channel', scopeKey: ORG, source: 'memory_search' }],
      charsExposed: 0,
      charBudget: 60_000,
    };
    const entries = resolveProvenanceScopes(prov, lookups);
    expect(entries[0]!.visibility).toBe('restricted');
  });
});
