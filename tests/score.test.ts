/**
 * Scoring tests.
 *
 * The parity test is the important one: if score.ts drifts from the model that
 * evaluation/train_model.py actually evaluated, every number in the evaluation report
 * describes a different model than the one making decisions.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { explainScore, loadModel, scoreRecoveryProbability } from '../src/decisions/score.js';
import type { ScoringInput } from '../src/decisions/score.js';

interface ParityFixtures {
  cases: Array<{ input: ScoringInput; expected: number }>;
}

const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), 'evaluation', 'parity-fixtures.json'), 'utf8'),
) as ParityFixtures;

function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    amountPaise: 149_900,
    priorSuccessCount: 2,
    priorFailureCount: 0,
    diagnosis: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',
    attemptNumber: 1,
    paymentMethod: 'upi',
    ...overrides,
  };
}

describe('TypeScript scoring matches scikit-learn', () => {
  it('reproduces every exported probability', () => {
    // Tolerance is float-representation noise, not modelling slack.
    for (const { input: row, expected } of fixtures.cases) {
      expect(scoreRecoveryProbability(row)).toBeCloseTo(expected, 6);
    }
  });

  it('covers a meaningful probability range', () => {
    // A fixture set clustered at one value would pass parity while testing nothing.
    const scored = fixtures.cases.map((c) => scoreRecoveryProbability(c.input));
    expect(Math.max(...scored) - Math.min(...scored)).toBeGreaterThan(0.2);
  });
});

describe('scores behave sensibly', () => {
  it('stays within a probability range', () => {
    for (const diagnosis of ['TEMPORARY_BANK_OR_NETWORK_FAILURE', 'USER_ABANDONMENT', 'UNKNOWN'] as const) {
      const p = scoreRecoveryProbability(input({ diagnosis }));
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('rates a transient failure above an abandoned checkout', () => {
    // Recovers the ordering in RESPONSE_MODEL.md: someone whose bank timed out wanted
    // to pay; someone who walked away from the cart did not.
    const transient = scoreRecoveryProbability(input({ diagnosis: 'TEMPORARY_BANK_OR_NETWORK_FAILURE' }));
    const abandoned = scoreRecoveryProbability(input({ diagnosis: 'USER_ABANDONMENT' }));
    expect(transient).toBeGreaterThan(abandoned);
  });

  it('penalises a history of failures', () => {
    const clean = scoreRecoveryProbability(input({ priorFailureCount: 0 }));
    const repeated = scoreRecoveryProbability(input({ priorFailureCount: 5 }));
    expect(repeated).toBeLessThan(clean);
  });

  it('rates a large order below a small one', () => {
    const small = scoreRecoveryProbability(input({ amountPaise: 20_000 }));
    const large = scoreRecoveryProbability(input({ amountPaise: 5_000_000 }));
    expect(large).toBeLessThan(small);
  });

  it('is deterministic', () => {
    const probe = input();
    const first = scoreRecoveryProbability(probe);
    for (let i = 0; i < 20; i++) {
      expect(scoreRecoveryProbability(probe)).toBe(first);
    }
  });
});

describe('score explanations', () => {
  it('names the features that moved the estimate', () => {
    const reasons = explainScore(input());
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' ')).toMatch(/raises|lowers/);
  });

  it('leads with the largest contribution', () => {
    // The diagnosis dominates the model, so it should lead the explanation.
    expect(explainScore(input({ diagnosis: 'TEMPORARY_BANK_OR_NETWORK_FAILURE' }))[0])
      .toContain('is_temporary_failure');
  });
});

describe('model file integrity', () => {
  it('has one coefficient per feature and matching scaling', () => {
    const model = loadModel();
    expect(model.coefficients).toHaveLength(model.features.length);
    expect(model.standardisation.mean).toHaveLength(model.features.length);
    expect(model.standardisation.std).toHaveLength(model.features.length);
  });

  it('rejects a model whose features score.ts cannot compute', () => {
    const broken = { ...loadModel(), features: ['a_feature_that_does_not_exist'] };
    expect(() => scoreRecoveryProbability(input(), broken)).toThrow(/does not compute/);
  });
});
