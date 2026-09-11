import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadEvalSet,
  evaluateFixture,
  computeMetrics,
  runVersion,
  compareVersions,
  canRollForward,
  REQUIRED_LABELS,
  type EvalSet,
  type EvalFixture,
} from './harness.js';

/**
 * Versioned prompt evaluation harness (Sections 46.4, 47; task T117).
 *
 * Acceptance: "The harness produces comparable reports by prompt version and
 * includes at least one fixture for every labeled outcome."
 */

const EPISODES_PATH = fileURLToPath(new URL('./episodes.json', import.meta.url));
const SET = loadEvalSet(JSON.parse(readFileSync(EPISODES_PATH, 'utf8'))) as EvalSet;
const BASELINE = 'v1.0.0-baseline';
const TUNED = 'v1.1.0-tuned';

describe('eval dataset — episodes.json', () => {
  it('includes at least one fixture for every labeled outcome', () => {
    const labels = new Set(SET.episodes.map((e) => e.label));
    for (const required of REQUIRED_LABELS) {
      expect(labels.has(required), `missing label ${required}`).toBe(true);
    }
  });

  it('declares matching prompt versions and carries a response for each', () => {
    expect(SET.promptVersions).toEqual([BASELINE, TUNED]);
    for (const episode of SET.episodes) {
      for (const version of SET.promptVersions) {
        expect(episode.responses[version], `${episode.id} missing ${version}`).toBeDefined();
      }
    }
  });

  it('carries no production content — only counts, ids, and synthetic text', () => {
    const blob = JSON.stringify(SET);
    // No real Discord tokens, snowflakes are placeholder-short, no secrets.
    expect(blob).not.toMatch(/discord\.gg|mfa\.|sk-[A-Za-z0-9]{20}/);
    expect(blob).not.toMatch(/token|secret|password/i);
  });
});

describe('evaluateFixture — deterministic host routing', () => {
  function evalFor(id: string, version: string) {
    const fixture = SET.episodes.find((e) => e.id === id)!;
    return evaluateFixture(fixture, fixture.responses[version], SET.thresholds);
  }

  it('routes a no-response episode to silent', () => {
    expect(evalFor('eval-silent', BASELINE).outcome).toBe('silent');
    expect(evalFor('eval-silent', BASELINE).correct).toBe(true);
  });

  it('routes a memory-only episode (no supersede) to memory_only', () => {
    expect(evalFor('eval-memory-only', BASELINE).outcome).toBe('memory_only');
  });

  it('routes a superseding memory to lifecycle_update', () => {
    expect(evalFor('eval-lifecycle', BASELINE).outcome).toBe('lifecycle_update');
  });

  it('routes a confident autonomous-mode proposal to autonomous', () => {
    expect(evalFor('eval-autonomous', BASELINE).outcome).toBe('autonomous');
    expect(evalFor('eval-autonomous', BASELINE).interrupted).toBe(true);
  });

  it('routes a review-mode proposal to review', () => {
    expect(evalFor('eval-review', BASELINE).outcome).toBe('review');
  });

  it('refuses a restricted-evidence leak proposed to org scope', () => {
    // Baseline model proposes surfacing restricted evidence to the whole org.
    const v1 = evalFor('eval-refusal', BASELINE);
    expect(v1.outcome).toBe('visibility_refusal');
    expect(v1.privacyViolation).toBe(true);
    // Tuned model proposes nothing at all — also a correct, privacy-safe resolution.
    const v2 = evalFor('eval-refusal', TUNED);
    expect(v2.outcome).toBe('silent');
    expect(v2.privacyViolation).toBe(false);
    expect(v2.correct).toBe(true);
  });
});

describe('computeMetrics — Section 46.4 aggregation', () => {
  it('computes all nine metrics for a version', () => {
    const report = runVersion(SET, BASELINE);
    const m = report.metrics;
    expect(m.episodeCount).toBe(SET.episodes.length);
    for (const key of [
      'interventionPrecision',
      'unnecessaryInterruptionRate',
      'validEvidenceRate',
      'memoryDuplicationRate',
      'humanApprovalRate',
      'averageResponseLength',
      'costPerReviewedEpisode',
      'labelAccuracy',
    ] as const) {
      expect(typeof m[key]).toBe('number');
      expect(Number.isFinite(m[key])).toBe(true);
    }
    expect(typeof m.privacyViolations).toBe('number');
    expect(m.dismissalReasons).toBeTypeOf('object');
  });

  it('counts a privacy violation exactly once per leaky proposal', () => {
    expect(runVersion(SET, BASELINE).metrics.privacyViolations).toBe(1);
    expect(runVersion(SET, TUNED).metrics.privacyViolations).toBe(0);
  });

  it('counts duplicate memories only among memory-extracting episodes', () => {
    expect(runVersion(SET, BASELINE).metrics.memoryDuplicationRate).toBeCloseTo(1 / 3, 5);
    expect(runVersion(SET, TUNED).metrics.memoryDuplicationRate).toBe(0);
  });
});

describe('runVersion / compareVersions — comparable per-version reports', () => {
  it('produces a VersionReport with the same shape for every version', () => {
    const reports = SET.promptVersions.map((v) => runVersion(SET, v));
    for (const r of reports) {
      expect(r.promptVersion).toBeTypeOf('string');
      expect(Array.isArray(r.evaluations)).toBe(true);
      expect(r.evaluations).toHaveLength(SET.episodes.length);
      expect(r.metrics).toBeTypeOf('object');
    }
  });

  it('shows the tuned version with higher precision and no privacy violations', () => {
    const baseline = runVersion(SET, BASELINE);
    const tuned = runVersion(SET, TUNED);

    // Baseline proposes a leaky intervention the host must refuse, lowering precision.
    expect(baseline.metrics.interventionPrecision).toBeCloseTo(0.75, 5);
    // Tuned drops the leaky proposal entirely; every proposal it makes is correct.
    expect(tuned.metrics.interventionPrecision).toBe(1);
    expect(tuned.metrics.interventionPrecision).toBeGreaterThan(baseline.metrics.interventionPrecision);

    // Fewer model-proposed interventions overall (the leaky one is gone).
    const baselineProposals = baseline.evaluations.filter((e) => e.proposedIntervention).length;
    const tunedProposals = tuned.evaluations.filter((e) => e.proposedIntervention).length;
    expect(tunedProposals).toBeLessThan(baselineProposals);
  });

  it('gates autonomous rollout on zero privacy violations and sufficient precision', () => {
    const baseline = runVersion(SET, BASELINE);
    const tuned = runVersion(SET, TUNED);

    expect(canRollForward(baseline.metrics, SET.thresholds)).toBe(false);
    expect(canRollForward(tuned.metrics, SET.thresholds)).toBe(true);
  });

  it('flags the candidate as improved on privacy and precision via compareVersions', () => {
    const baseline = runVersion(SET, BASELINE);
    const tuned = runVersion(SET, TUNED);
    const cmp = compareVersions(baseline, tuned);

    expect(cmp.baseline).toBe(BASELINE);
    expect(cmp.candidate).toBe(TUNED);
    expect(cmp.baselineReady).toBe(false);
    expect(cmp.candidateReady).toBe(true);
    expect(cmp.better).toContain('privacyViolations');
    expect(cmp.better).toContain('interventionPrecision');
    // The candidate must not regress on any lower-is-better rollout metric.
    expect(cmp.worse).not.toContain('privacyViolations');
  });
});

describe('loadEvalSet — validation', () => {
  it('rejects a fixture set missing a required label', () => {
    const partial: EvalSet = {
      version: 'x',
      promptVersions: ['v1'],
      thresholds: SET.thresholds,
      episodes: [
        { id: 'a', label: 'silent', visibility: 'org', mode: 'observe', conversationMessageCount: 1, responses: {} },
      ],
    };
    expect(() => loadEvalSet(partial)).toThrow(/missing required labels/);
  });

  it('rejects an unknown prompt version at run time', () => {
    expect(() => runVersion(SET, 'v9.9.9-nope')).toThrow(/unknown prompt version/);
  });

  it('applies default thresholds when none are declared', () => {
    const fixture: EvalFixture = {
      id: 'x',
      label: 'silent',
      visibility: 'org',
      mode: 'observe',
      conversationMessageCount: 1,
      responses: { v1: { memories: [], notification: null, costUsd: 0, responseLengthChars: 0 } },
    };
    const set = loadEvalSet({ version: '1', promptVersions: ['v1'], episodes: [fixture, {
      id: 'y', label: 'memory_only', visibility: 'org', mode: 'observe', conversationMessageCount: 1,
      responses: { v1: { memories: [{ id: 'm', text: 't' }], notification: null, costUsd: 0, responseLengthChars: 0 } },
    }, {
      id: 'z', label: 'review', visibility: 'org', mode: 'review', conversationMessageCount: 1,
      responses: { v1: { memories: [], notification: mkNotification(), costUsd: 0, responseLengthChars: 0 } },
    }, {
      id: 'w', label: 'autonomous', visibility: 'org', mode: 'autonomous', conversationMessageCount: 1,
      responses: { v1: { memories: [], notification: { ...mkNotification(), confidence: 0.9 }, costUsd: 0, responseLengthChars: 0 } },
    }, {
      id: 'u', label: 'lifecycle_update', visibility: 'org', mode: 'observe', conversationMessageCount: 1,
      responses: { v1: { memories: [{ id: 'm2', text: 't', supersededId: 'm' }], notification: null, costUsd: 0, responseLengthChars: 0 } },
    }, {
      id: 't', label: 'visibility_refusal', visibility: 'restricted', mode: 'autonomous', conversationMessageCount: 1,
      responses: { v1: { memories: [], notification: { ...mkNotification(), evidenceRestricted: true, targetVisibility: 'org' }, costUsd: 0, responseLengthChars: 0 } },
    }] });
    expect(set.thresholds.interventionConfidence).toBe(0.78);
  });

  function mkNotification() {
    return {
      recommend: true,
      confidence: 0.7,
      targetVisibility: 'review_only' as const,
      evidenceRestricted: false,
      evidenceStrength: 0.8,
      evidenceMessageIds: ['m1'],
    };
  }

  it('returns a finite metrics object even for a degenerate single-episode set', () => {
    const m = computeMetrics([
      { fixtureId: 'x', label: 'silent', outcome: 'silent', correct: true, interrupted: false, proposedIntervention: false, correctIntervention: false, validEvidence: false, duplicateMemory: false, privacyViolation: false, costUsd: 0, responseLengthChars: 0, reviewed: false },
    ]);
    // With no proposals and no interruptions, the "higher is better" rates
    // default to 1 (vacuously correct) and the rest to 0.
    expect(m.privacyViolations).toBe(0);
    expect(m.labelAccuracy).toBe(1);
  });
});
