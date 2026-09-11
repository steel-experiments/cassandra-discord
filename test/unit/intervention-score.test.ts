import { describe, it, expect } from 'vitest';
import { computeInterventionScore, type InterventionDimensions } from '../../src/agent/policy.js';

function dims(over: Partial<InterventionDimensions> = {}): InterventionDimensions {
  return {
    impact: 0,
    evidenceStrength: 0,
    contradictionStrength: 0,
    urgency: 0,
    novelty: 0,
    interruptionCost: 0,
    ...over,
  };
}

describe('deterministic intervention scoring', () => {
  it('produces the Section 24.1 score for known fixtures', () => {
    // All 0.5: positive = 1.0·0.5 = 0.5; minus 0.25·0.5 = 0.375.
    expect(computeInterventionScore(dims({
      impact: 0.5, evidenceStrength: 0.5, contradictionStrength: 0.5,
      urgency: 0.5, novelty: 0.5, interruptionCost: 0.5,
    }))).toBeCloseTo(0.375, 10);

    // All 1.0: positive = 1.0; minus 0.25 = 0.75.
    expect(computeInterventionScore(dims({
      impact: 1, evidenceStrength: 1, contradictionStrength: 1,
      urgency: 1, novelty: 1, interruptionCost: 1,
    }))).toBeCloseTo(0.75, 10);

    // Only impact = 1, interruptionCost = 1: 0.30 − 0.25 = 0.05.
    expect(computeInterventionScore(dims({ impact: 1, interruptionCost: 1 }))).toBeCloseTo(0.05, 10);

    // Only novelty = 1: 0.10.
    expect(computeInterventionScore(dims({ novelty: 1 }))).toBeCloseTo(0.1, 10);
  });

  it('clamps the lower bound at 0 when interruption cost dominates', () => {
    // positive = 0; minus 0.25·1 = −0.25 → clamp 0.
    expect(computeInterventionScore(dims({ interruptionCost: 1 }))).toBe(0);
  });

  it('clamps the upper bound at 1 when everything aligns with no interruption cost', () => {
    expect(
      computeInterventionScore(
        dims({
          impact: 1,
          evidenceStrength: 1,
          contradictionStrength: 1,
          urgency: 1,
          novelty: 1,
          interruptionCost: 0,
        }),
      ),
    ).toBe(1);
  });

  it('weights each dimension by its Section 24.1 coefficient', () => {
    // Move each dimension from 0 to 1 in isolation with interruptionCost fixed at 0.
    expect(computeInterventionScore(dims({ impact: 1 }))).toBeCloseTo(0.3, 10);
    expect(computeInterventionScore(dims({ evidenceStrength: 1 }))).toBeCloseTo(0.25, 10);
    expect(computeInterventionScore(dims({ contradictionStrength: 1 }))).toBeCloseTo(0.2, 10);
    expect(computeInterventionScore(dims({ urgency: 1 }))).toBeCloseTo(0.15, 10);
    expect(computeInterventionScore(dims({ novelty: 1 }))).toBeCloseTo(0.1, 10);
    // Raising interruption cost lowers the score by 0.25 per unit (before clamp).
    const base = computeInterventionScore(dims({ impact: 1 }));
    const costlier = computeInterventionScore(dims({ impact: 1, interruptionCost: 1 }));
    expect(base - costlier).toBeCloseTo(0.25, 10);
  });

  it('is independent of the model recommendation (pure function of dimensions)', () => {
    // The function takes dimensions only; recommend never enters the arithmetic.
    const d = dims({ impact: 0.9, evidenceStrength: 0.8, interruptionCost: 0.2 });
    const a = computeInterventionScore(d);
    const expected = 0.3 * 0.9 + 0.25 * 0.8 - 0.25 * 0.2;
    expect(a).toBeCloseTo(expected, 10);
  });

  it('rejects non-finite or non-numeric dimensions', () => {
    expect(() => computeInterventionScore(dims({ impact: Number.NaN }))).toThrow(TypeError);
    expect(() => computeInterventionScore(dims({ impact: Number.POSITIVE_INFINITY }))).toThrow(
      TypeError,
    );
    expect(() => computeInterventionScore(dims({ evidenceStrength: '0.5' as unknown as number }))).toThrow(
      TypeError,
    );
  });
});
