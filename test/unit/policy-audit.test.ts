import { describe, expect, it } from 'vitest';
import type { ProposalRoutingInput, ProposalRoutingResult } from '../../src/agent/policy.js';
import { buildEpisodePolicyDecision, buildScheduledPolicyDecision } from '../../src/agent/policy-audit.js';

describe('policy decision audit', () => {
  it('copies only the episode allowlist and omits message/duplicate preview/tool data', () => {
    const input = {
      mode: 'observe', thresholds: { score: .7, confidence: .6, evidenceStrength: .5, maxContentLength: 1800 },
      eligibility: { recommend: true, dimensions: { impact: 1, evidenceStrength: .8, contradictionStrength: .7, urgency: .6, novelty: .5, interruptionCost: .1 }, confidence: .9, evidenceStrength: .8, evidenceCount: 1, contentLength: 42, hasDisallowedMention: true },
      provenanceGate: { outcome: 'allow', reasons: [] }, outboundEvidence: { outcome: 'allow', reasons: [] },
      forcedReview: { forceReview: false, rules: [] }, cooldown: { allowed: true, blocks: [] },
      duplicate: { matched: true, similarity: .9, messagePreview: 'SECRET_PREVIEW' },
      message: 'SECRET_MESSAGE', toolData: 'SECRET_TOOL',
    } as unknown as ProposalRoutingInput;
    const result = buildEpisodePolicyDecision(input, { state: 'observed', score: .748, reasons: ['disallowed mention'] } as ProposalRoutingResult, { outcome: 'reject', reasons: ['user mention'] });
    expect(result).toMatchObject({ kind: 'episode_intervention', score: .748, outboundSafety: { outcome: 'reject' } });
    const json = JSON.stringify(result);
    expect(json).not.toContain('SECRET_PREVIEW');
    expect(json).not.toContain('SECRET_MESSAGE');
    expect(json).not.toContain('SECRET_TOOL');
  });

  it('uses a distinct scheduled shape without episode dimensions', () => {
    const result = buildScheduledPolicyDecision({ mode: 'review', state: 'observed', recommend: true,
      notificationsAllowed: true, targetMatches: true, outboundSafety: { outcome: 'reject', reasons: ['mention'] },
      subjectBlockingReasons: ['subject unavailable'], reasons: ['blocked'] });
    expect(result.kind).toBe('scheduled_notification');
    expect(JSON.stringify(result)).not.toContain('dimensions');
  });
});
