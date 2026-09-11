import { describe, it, expect } from 'vitest';
import {
  createFinalizeEpisodeReviewTool,
  createFinalizeDirectAnswerTool,
  createFinalizeScheduledReviewTool,
  RunFinalizationState,
  type AcceptedProposal,
  type FinalizeCommit,
} from '../../src/agent/tools/finalize.js';

const PINNED = 'target-channel-1';

const dims = {
  impact: 0.5,
  evidenceStrength: 0.5,
  contradictionStrength: 0.5,
  urgency: 0.5,
  novelty: 0.5,
  interruptionCost: 0.5,
};

function episodeReview(target = PINNED) {
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
      targetChannelId: target,
      evidenceMessageIds: ['111'],
    },
    unresolvedQuestions: [],
  };
}

function directAnswer(target = PINNED) {
  return {
    targetChannelId: target,
    message: 'Here is the answer.',
    citedMessageIds: ['1', '2', '3'],
  };
}

function scheduledReview(target = PINNED) {
  return {
    memoryProposals: [],
    notification: {
      recommend: false,
      reason: 'none',
      targetChannelId: target,
      evidenceMessageIds: [],
      subjectMemoryIds: [],
    },
  };
}

function textOf(r: { content: { text?: string }[] }): string {
  return (r.content[0]?.text ?? '') as string;
}

describe('terminal finalization tools', () => {
  it('accepts a correctly-targeted episode review, commits it verbatim, and terminates', async () => {
    const state = new RunFinalizationState(PINNED);
    const committed: AcceptedProposal[] = [];
    const commit: FinalizeCommit = (p) => committed.push(p);
    const tool = createFinalizeEpisodeReviewTool(state, commit);

    const proposal = episodeReview();
    const res = await tool.execute('c1', proposal);

    expect(res.terminate).toBe(true);
    expect(res.details.accepted).toBe(true);
    expect(res.details.kind).toBe('episode_review');
    expect(res.details.attempts).toBe(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.proposal).toEqual(proposal);
    expect(state.accepted?.proposal).toEqual(proposal);
  });

  it('rejects a retargeted proposal once, then fails the run on a second rejection', async () => {
    const state = new RunFinalizationState(PINNED);
    const tool = createFinalizeEpisodeReviewTool(state);

    const first = await tool.execute('c1', episodeReview('other-channel'));
    expect(first.terminate).toBe(false);
    expect(first.details.accepted).toBe(false);
    expect(first.details.attempts).toBe(1);
    expect(textOf(first)).toContain('pinned target');
    expect(state.accepted).toBeNull();

    // A second rejection exhausts the single correction and throws.
    await expect(tool.execute('c2', episodeReview('other-channel'))).rejects.toThrow(
      /one correction/,
    );
  });

  it('permits exactly one correction: a rejected run can still accept on retry', async () => {
    const state = new RunFinalizationState(PINNED);
    const tool = createFinalizeEpisodeReviewTool(state);

    const rejected = await tool.execute('c1', episodeReview('wrong'));
    expect(rejected.details.accepted).toBe(false);

    const accepted = await tool.execute('c2', episodeReview(PINNED));
    expect(accepted.terminate).toBe(true);
    expect(accepted.details.accepted).toBe(true);
    expect(accepted.details.attempts).toBe(2);
  });

  it('rejects a schema-invalid proposal correctably (out-of-range confidence)', async () => {
    const state = new RunFinalizationState(PINNED);
    const tool = createFinalizeEpisodeReviewTool(state);
    const bad = episodeReview();
    (bad as unknown as { intervention: { confidence: number } }).intervention.confidence = 1.5;

    const res = await tool.execute('c1', bad);
    expect(res.details.accepted).toBe(false);
    expect(res.terminate).toBe(false);
    expect(textOf(res)).toContain('validation');
    expect(state.accepted).toBeNull();
  });

  it('direct-answer and scheduled-review tools pin their own target field', async () => {
    const daState = new RunFinalizationState(PINNED);
    const da = createFinalizeDirectAnswerTool(daState);
    const daRejected = await da.execute('c1', directAnswer('elsewhere'));
    expect(daRejected.details.accepted).toBe(false);
    const daAccepted = await da.execute('c2', directAnswer(PINNED));
    expect(daAccepted.terminate).toBe(true);
    expect(daAccepted.details.kind).toBe('direct_answer');

    const srState = new RunFinalizationState(PINNED);
    const sr = createFinalizeScheduledReviewTool(srState);
    const srAccepted = await sr.execute('c1', scheduledReview(PINNED));
    expect(srAccepted.terminate).toBe(true);
    expect(srAccepted.details.kind).toBe('scheduled_review');
  });

  it('applies an optional semantic validator through the one-correction gate', async () => {
    const state = new RunFinalizationState(PINNED);
    const tool = createFinalizeDirectAnswerTool(state, undefined, (proposal) =>
      proposal.citedMessageIds.includes('snapshot-message')
        ? null
        : 'The answer must cite the snapshot.',
    );

    const rejected = await tool.execute('c1', {
      ...directAnswer(),
      citedMessageIds: [],
    });
    expect(rejected.terminate).toBe(false);
    expect(rejected.details).toMatchObject({ accepted: false, attempts: 1 });
    expect(textOf(rejected)).toContain('must cite the snapshot');
    expect(state.accepted).toBeNull();

    const corrected = await tool.execute('c2', {
      ...directAnswer(),
      citedMessageIds: ['snapshot-message'],
    });
    expect(corrected.terminate).toBe(true);
    expect(corrected.details).toMatchObject({ accepted: true, attempts: 2 });
    expect(state.accepted?.proposal).toMatchObject({
      citedMessageIds: ['snapshot-message'],
    });
  });

  it('does not mutate memory or post to Discord — commit is the only side effect', async () => {
    const state = new RunFinalizationState(PINNED);
    let calls = 0;
    const commit: FinalizeCommit = () => {
      calls += 1;
    };
    const tool = createFinalizeDirectAnswerTool(state, commit);
    const res = await tool.execute('c1', directAnswer(PINNED));
    expect(res.terminate).toBe(true);
    expect(calls).toBe(1);
    // The tool exposes no db, memory, or Discord handle — acceptance is pure.
    expect(state.accepted?.kind).toBe('direct_answer');
  });
});
