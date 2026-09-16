import { describe, it, expect } from 'vitest';
import {
  validate,
  FinalizeEpisodeReview,
  FinalizeDirectAnswer,
  FinalizeScheduledReview,
  SearchMessagesToolInput,
  SearchMemoriesToolInput,
  ListMemoriesToolInput,
} from '../../src/agent/schemas.js';

const dims = {
  impact: 0.5,
  evidenceStrength: 0.5,
  contradictionStrength: 0.5,
  urgency: 0.5,
  novelty: 0.5,
  interruptionCost: 0.5,
};

function validEpisodeReview() {
  return {
    episodeSummary: 'We adopted the trial.',
    consequential: true,
    memoryProposals: [
      {
        action: 'create',
        type: 'decision',
        statement: 'Adopt the onboarding trial.',
        confidence: 0.8,
        importance: 0.7,
        evidenceMessageIds: ['111', '222'],
        evidenceQuotes: [{ messageId: '111', quote: 'adopted' }, { messageId: '222', quote: 'trial' }],
        durability: 'project',
        durabilityReason: 'This changes future onboarding work.',
      },
    ],
    intervention: {
      recommend: false,
      reason: 'nothing urgent',
      dimensions: dims,
      confidence: 0.5,
      urgency: 'normal',
      targetChannelId: '999',
      evidenceMessageIds: ['111'],
    },
    unresolvedQuestions: [],
  };
}

describe('agent schemas', () => {
  it('accepts valid episode-review, direct-answer, and scheduled-review fixtures', () => {
    expect(validate(FinalizeEpisodeReview, validEpisodeReview()).ok).toBe(true);
    expect(
      validate(FinalizeDirectAnswer, {
        targetChannelId: '999',
        message: 'Here is the answer.',
        citedMessageIds: ['1', '2', '3'],
      }).ok,
    ).toBe(true);
    expect(
      validate(FinalizeScheduledReview, {
        memoryProposals: [],
        notification: {
          recommend: false,
          reason: 'none',
          targetChannelId: 'rev',
          evidenceMessageIds: [],
          subjectMemoryIds: [],
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects out-of-range scores', () => {
    const bad = validEpisodeReview();
    (bad as unknown as { intervention: { confidence: number } }).intervention.confidence = 1.5;
    expect(validate(FinalizeEpisodeReview, bad).ok).toBe(false);
  });

  it('rejects an invalid enum value', () => {
    const bad = validEpisodeReview();
    (bad as unknown as { intervention: { urgency: string } }).intervention.urgency = 'whenever';
    const r = validate(FinalizeEpisodeReview, bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('urgency'))).toBe(true);
  });

  it('rejects a memory proposal missing evidence', () => {
    const bad = validEpisodeReview();
    (bad.memoryProposals[0] as unknown as { evidenceMessageIds: string[] }).evidenceMessageIds = [];
    const r = validate(FinalizeEpisodeReview, bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('evidenceMessageIds'))).toBe(true);
  });

  it('rejects oversized text', () => {
    const bad = validEpisodeReview();
    bad.episodeSummary = 'x'.repeat(1601);
    expect(validate(FinalizeEpisodeReview, bad).ok).toBe(false);
  });

  it('rejects unknown properties at top and nested levels', () => {
    const top = validEpisodeReview() as Record<string, unknown>;
    top.sneaky = 1;
    expect(validate(FinalizeEpisodeReview, top).ok).toBe(false);

    const nested = validEpisodeReview();
    (nested.intervention as unknown as Record<string, unknown>).extra = 'x';
    const r = validate(FinalizeEpisodeReview, nested);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('extra'))).toBe(true);
  });

  it('rejects excessive arrays beyond item caps', () => {
    const bad = validEpisodeReview();
    bad.memoryProposals = Array.from({ length: 21 }, () => ({ ...bad.memoryProposals[0]! }));
    expect(validate(FinalizeEpisodeReview, bad).ok).toBe(false);

    const tooManyCitations = {
      targetChannelId: '999',
      message: 'answer',
      citedMessageIds: ['1', '2', '3', '4'],
    };
    expect(validate(FinalizeDirectAnswer, tooManyCitations).ok).toBe(false);
  });

  it('rejects missing required fields', () => {
    const partial = { episodeSummary: 's' };
    const r = validate(FinalizeEpisodeReview, partial);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects a scheduled notification without subject memory identifiers', () => {
    const r = validate(FinalizeScheduledReview, {
      memoryProposals: [],
      notification: {
        recommend: true,
        reason: 'The due item needs a current status.',
        targetChannelId: 'rev',
        message: 'Please record the current status.',
        evidenceMessageIds: ['m1'],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((error) => error.path.includes('subjectMemoryIds'))).toBe(true);
  });

  it('validates retrieval tool inputs with caps and enums', () => {
    expect(validate(SearchMessagesToolInput, { query: 'onboarding', limit: 50 }).ok).toBe(true);
    expect(validate(SearchMessagesToolInput, { query: '', limit: 50 }).ok).toBe(false); // empty query
    expect(validate(SearchMessagesToolInput, { query: 'x', limit: 51 }).ok).toBe(false); // limit over cap
    expect(
      validate(SearchMemoriesToolInput, { query: 'x', types: ['decision', 'bogus'] }).ok,
    ).toBe(false); // bad enum in array
    expect(validate(ListMemoriesToolInput, {}).ok).toBe(true);
    expect(validate(ListMemoriesToolInput, { types: ['decision'], limit: 50 }).ok).toBe(true);
    expect(validate(ListMemoriesToolInput, { query: '*' }).ok).toBe(false); // no query input
    expect(validate(ListMemoriesToolInput, { statuses: ['active', 'bogus'] }).ok).toBe(false);
  });

  it('returns bounded field-level error paths for one correction attempt', () => {
    const bad = validEpisodeReview();
    (bad as unknown as { intervention: { confidence: number } }).intervention.confidence = 2;
    const r = validate(FinalizeEpisodeReview, bad);
    expect(r.ok).toBe(false);
    expect(r.errors.every((e) => typeof e.path === 'string' && typeof e.message === 'string')).toBe(true);
  });

  it('accepts optional attention subject, trigger, and revision echo (Section 12.7)', () => {
    const withSubject = validEpisodeReview();
    const intervention = withSubject.intervention as unknown as Record<string, unknown>;
    intervention.subject = { kind: 'memory_proposal', proposalIndex: 0 };
    intervention.trigger = {
      kind: 'new_human_evidence',
      evidence: [{ messageId: '111', quote: 'adopted' }],
      relation: 'new_commitment',
      materialChange: 'The team committed to the trial.',
    };
    expect(validate(FinalizeEpisodeReview, withSubject).ok).toBe(true);

    const deadlineTrigger = validEpisodeReview();
    (deadlineTrigger.intervention as unknown as Record<string, unknown>).trigger = {
      kind: 'human_deadline',
      revisionId: 'rev-1',
    };
    expect(validate(FinalizeEpisodeReview, deadlineTrigger).ok).toBe(true);

    const noneTrigger = validEpisodeReview();
    (noneTrigger.intervention as unknown as Record<string, unknown>).trigger = { kind: 'none' };
    expect(validate(FinalizeEpisodeReview, noneTrigger).ok).toBe(true);

    const scheduled = {
      memoryProposals: [],
      notification: {
        recommend: true,
        reason: 'current change',
        targetChannelId: '999',
        message: 'text',
        evidenceMessageIds: ['111'],
        subjectMemoryIds: ['m1'],
        attentionRevisionId: 'rev-1',
      },
    };
    expect(validate(FinalizeScheduledReview, scheduled).ok).toBe(true);
  });

  it('rejects malformed attention subject and trigger declarations', () => {
    const badSubject = validEpisodeReview();
    (badSubject.intervention as unknown as Record<string, unknown>).subject = {
      kind: 'existing_memory',
      memoryId: '',
    };
    expect(validate(FinalizeEpisodeReview, badSubject).ok).toBe(false);

    const badTrigger = validEpisodeReview();
    (badTrigger.intervention as unknown as Record<string, unknown>).trigger = {
      kind: 'new_human_evidence',
      evidence: [],
      relation: 'somehow_relevant',
      materialChange: 'x',
    };
    const r = validate(FinalizeEpisodeReview, badTrigger);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.path.includes('trigger'))).toBe(true);

    const outOfRange = validEpisodeReview();
    (outOfRange.intervention as unknown as Record<string, unknown>).subject = {
      kind: 'memory_proposal',
      proposalIndex: 20,
    };
    expect(validate(FinalizeEpisodeReview, outOfRange).ok).toBe(false);
  });

  it('accepts optional attentionChange and deadlineChange on memory proposals', () => {
    const withChanges = validEpisodeReview();
    const proposal = withChanges.memoryProposals[0] as unknown as Record<string, unknown>;
    proposal.attentionChange = {
      evidence: [{ messageId: '111', quote: 'adopted' }],
      relation: 'new_commitment',
      materialChange: 'The team committed to the trial.',
    };
    proposal.deadlineChange = {
      action: 'set',
      sourceMessageId: '111',
      quote: 'adopted by Friday',
      dateExpression: 'Friday',
      proposedAt: '2026-09-18T00:00:00Z',
    };
    expect(validate(FinalizeEpisodeReview, withChanges).ok).toBe(true);

    const badDeadline = validEpisodeReview();
    (badDeadline.memoryProposals[0] as unknown as Record<string, unknown>).deadlineChange = {
      action: 'set',
      sourceMessageId: '111',
      quote: 'adopted by Friday',
      dateExpression: 'whenever it lands',
    };
    const r = validate(FinalizeEpisodeReview, badDeadline);
    expect(r.ok).toBe(true); // grammar rejection is host-side, not structural
    expect(badDeadline).toBeDefined();

    const clearForm = validEpisodeReview();
    (clearForm.memoryProposals[0] as unknown as Record<string, unknown>).deadlineChange = {
      action: 'clear',
      sourceMessageId: '111',
      quote: 'the deadline is cancelled',
    };
    expect(validate(FinalizeEpisodeReview, clearForm).ok).toBe(true);
  });
});
