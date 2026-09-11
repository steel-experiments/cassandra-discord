import { describe, it, expect } from 'vitest';
import {
  validateOutboundEvidence,
  type OutboundEvidenceLookups,
  type TargetScope,
} from '../../src/agent/policy.js';
import type { VisibilityClass } from '../../src/db/repositories/channels.js';

/**
 * Outbound evidence and reply validation (Sections 7.4 checks 3-7, 24.2).
 *
 * Acceptance: invented, deleted, invisible, stale-policy, and cross-channel
 * reply references never become outbox rows.
 */

const ORG = '100000000000000001';
const RESTRICTED_A = '100000000000000010';
const RESTRICTED_B = '100000000000000011';
const RESTRICTED_A_THREAD = '100000000000000012';
const REVIEW = '100000000000000099';

interface Msg {
  channelId: string;
  scopeChannelId?: string;
  visibility: VisibilityClass;
  deletedAtMs?: number | null;
}
interface Ch {
  visibility: VisibilityClass;
  allowInterventions: boolean;
  deletedAtMs?: number | null;
}

function lookups(opts: {
  messages?: Record<string, Msg>;
  memories?: Record<string, { scopeType: string; scopeKey: string | null }>;
  channels?: Record<string, Ch>;
} = {}): OutboundEvidenceLookups {
  const channels: Record<string, Ch> = {
    [ORG]: { visibility: 'org', allowInterventions: true },
    [RESTRICTED_A]: { visibility: 'restricted', allowInterventions: true },
    [RESTRICTED_B]: { visibility: 'restricted', allowInterventions: true },
    [REVIEW]: { visibility: 'review_only', allowInterventions: true },
    ...opts.channels,
  };
  const messages: Record<string, Msg> = {
    mOrg: { channelId: ORG, visibility: 'org' },
    mA: { channelId: RESTRICTED_A, visibility: 'restricted' },
    mB: { channelId: RESTRICTED_B, visibility: 'restricted' },
    mReply: { channelId: ORG, visibility: 'org' },
    ...opts.messages,
  };
  const memories = opts.memories ?? {};
  return {
    resolveMessage: (id) => {
      const m = messages[id];
      return m ? { channelId: m.channelId, scopeChannelId: m.scopeChannelId,
        visibility: m.visibility, deletedAtMs: m.deletedAtMs ?? null } : undefined;
    },
    resolveMemoryScope: (id) => memories[id],
    resolveChannel: (id) => {
      const c = channels[id];
      return c ? { visibility: c.visibility, allowInterventions: c.allowInterventions, deletedAtMs: c.deletedAtMs ?? null } : undefined;
    },
  };
}

const orgTarget = { channelId: ORG, visibility: 'org' as VisibilityClass, isSecureReview: false };
const restrictedTargetA = { channelId: RESTRICTED_A, visibility: 'restricted' as VisibilityClass, isSecureReview: false };
const restrictedThreadTarget: TargetScope = {
  channelId: RESTRICTED_A_THREAD,
  scopeChannelId: RESTRICTED_A,
  visibility: 'restricted',
  isSecureReview: false,
};
function validate(
  target: TargetScope,
  opts: { cited?: string[]; mems?: string[]; reply?: string | null } = {},
  lk: OutboundEvidenceLookups = lookups(),
) {
  return validateOutboundEvidence(
    {
      target,
      citedMessageIds: opts.cited ?? [],
      referencedMemoryIds: opts.mems ?? [],
      replyToMessageId: opts.reply ?? null,
    },
    lk,
  );
}

describe('validateOutboundEvidence — happy path', () => {
  it('allows an org target with org-visible cited sources and memories', () => {
    const res = validate(orgTarget, {
      cited: ['mOrg'],
      mems: ['memOrg'],
    }, lookups({ memories: { memOrg: { scopeType: 'org', scopeKey: null } } }));
    expect(res.outcome).toBe('allow');
  });

  it('allows a restricted target citing its own channel content', () => {
    expect(validate(restrictedTargetA, { cited: ['mA'] }).outcome).toBe('allow');
  });

  it('allows a restricted thread target to cite content anchored to its parent scope', () => {
    const lk = lookups({
      channels: {
        [RESTRICTED_A_THREAD]: { visibility: 'restricted', allowInterventions: true },
      },
      messages: {
        mThread: {
          channelId: RESTRICTED_A_THREAD,
          scopeChannelId: RESTRICTED_A,
          visibility: 'restricted',
        },
      },
      memories: { memParent: { scopeType: 'channel', scopeKey: RESTRICTED_A } },
    });
    expect(validate(restrictedThreadTarget, {
      cited: ['mThread'],
      mems: ['memParent'],
    }, lk).outcome).toBe('allow');
  });

  it('allows a valid reply anchor in the target channel', () => {
    expect(validate(orgTarget, { reply: 'mReply' }).outcome).toBe('allow');
  });
});

describe('validateOutboundEvidence — cited sources', () => {
  it('rejects an invented (non-existent) cited source', () => {
    const res = validate(orgTarget, { cited: ['made-up'] });
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('made-up'))).toBe(true);
  });

  it('rejects a deleted cited source', () => {
    const res = validate(orgTarget, { cited: ['mOrg'] }, lookups({ messages: { mOrg: { channelId: ORG, visibility: 'org', deletedAtMs: 123 } } }));
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('deleted'))).toBe(true);
  });

  it('rejects an invisible cited source (restricted content cited in an org target)', () => {
    const res = validate(orgTarget, { cited: ['mA'] });
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('not permitted'))).toBe(true);
  });

  it('rejects a cited source from a different restricted channel', () => {
    const res = validate(restrictedTargetA, { cited: ['mB'] });
    expect(res.outcome).toBe('reject');
  });
});

describe('validateOutboundEvidence — referenced memories', () => {
  it('rejects an invented referenced memory', () => {
    const res = validate(orgTarget, { mems: ['nope'] });
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('nope'))).toBe(true);
  });

  it('rejects a referenced memory scoped to a different restricted channel', () => {
    const res = validate(orgTarget, { mems: ['memA'] }, lookups({ memories: { memA: { scopeType: 'channel', scopeKey: RESTRICTED_A } } }));
    expect(res.outcome).toBe('reject');
  });

  it('does not broaden a channel-scoped memory merely because its anchor is org', () => {
    const res = validate(orgTarget, { mems: ['memThread'] }, lookups({
      memories: { memThread: { scopeType: 'channel', scopeKey: ORG } },
    }));
    expect(res.outcome).toBe('reject');
  });

  it('forces review for a referenced memory with unresolvable scope (uncertain)', () => {
    const res = validate(orgTarget, { mems: ['memX'] }, lookups({ memories: { memX: { scopeType: 'unknown_type', scopeKey: null } } }));
    expect(res.outcome).toBe('force_review');
  });

  it('allows a channel-scoped memory in its own restricted target', () => {
    const res = validate(restrictedTargetA, { mems: ['memA'] }, lookups({ memories: { memA: { scopeType: 'channel', scopeKey: RESTRICTED_A } } }));
    expect(res.outcome).toBe('allow');
  });
});

describe('validateOutboundEvidence — target policy', () => {
  it('rejects when the target channel was deleted', () => {
    const res = validate(orgTarget, {}, lookups({ channels: { [ORG]: { visibility: 'org', allowInterventions: true, deletedAtMs: 5 } } }));
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('deleted'))).toBe(true);
  });

  it('rejects when the target no longer allows interventions', () => {
    const res = validate(orgTarget, {}, lookups({ channels: { [ORG]: { visibility: 'org', allowInterventions: false } } }));
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('interventions'))).toBe(true);
  });

  it('rejects stale policy (target visibility changed since the run pinned it)', () => {
    // Channel reclassified org → restricted after the run assumed org.
    const res = validate(orgTarget, {}, lookups({ channels: { [ORG]: { visibility: 'restricted', allowInterventions: true } } }));
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('stale policy'))).toBe(true);
  });

  it('rejects when the target channel no longer exists', () => {
    const lk = lookups();
    const res = validateOutboundEvidence(
      { target: { channelId: 'gone', visibility: 'org', isSecureReview: false }, citedMessageIds: [], referencedMemoryIds: [] },
      lk,
    );
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('no longer exists'))).toBe(true);
  });
});

describe('validateOutboundEvidence — reply anchor', () => {
  it('rejects a missing reply anchor', () => {
    const res = validate(orgTarget, { reply: 'ghost' });
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('ghost'))).toBe(true);
  });

  it('rejects a cross-channel reply anchor', () => {
    const res = validate(orgTarget, { reply: 'mA' }); // mA is in RESTRICTED_A
    expect(res.outcome).toBe('reject');
    expect(res.reasons.some((r) => r.includes('different channel') || r.includes('not the target'))).toBe(true);
  });

  it('rejects a deleted reply anchor', () => {
    const res = validate(orgTarget, { reply: 'mReply' }, lookups({ messages: { mReply: { channelId: ORG, visibility: 'org', deletedAtMs: 9 } } }));
    expect(res.outcome).toBe('reject');
  });
});

describe('validateOutboundEvidence — composition', () => {
  it('collects multiple violations into one reject with several reasons', () => {
    const res = validate(
      orgTarget,
      { cited: ['made-up', 'mA'], mems: ['nope'] },
    );
    expect(res.outcome).toBe('reject');
    expect(res.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('never includes message content in reasons (redacted)', () => {
    const res = validate(orgTarget, { cited: ['made-up'] });
    for (const r of res.reasons) {
      expect(r).toMatch(/message|memory|channel|target|scope|policy|permitted|deleted|interventions|exist/i);
    }
  });
});
