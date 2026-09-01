/**
 * Recovery-propensity scoring.
 *
 * Reproduces the calibrated logistic regression trained by evaluation/train_model.py
 * from exported coefficients. A logistic regression is a dot product and a sigmoid;
 * standing up a Python service to compute one would add a network hop, a deployment
 * unit, and a failure mode, in exchange for nothing.
 *
 * A test asserts this scores identically to scikit-learn on the same rows, so the
 * reimplementation cannot drift from the model that was actually evaluated.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Diagnosis } from '../types.js';

interface ModelFile {
  readonly features: readonly string[];
  readonly standardisation: { readonly mean: readonly number[]; readonly std: readonly number[] };
  readonly coefficients: readonly number[];
  readonly intercept: number;
  readonly calibration: { readonly a: number; readonly b: number };
}

/** Everything the model reads. Deliberately a small, explicit surface. */
export interface ScoringInput {
  readonly amountPaise: number;
  readonly priorSuccessCount: number;
  readonly priorFailureCount: number;
  readonly diagnosis: Diagnosis;
  readonly attemptNumber: number;
  readonly paymentMethod: string;
}

let cached: ModelFile | null = null;

export function loadModel(path?: string): ModelFile {
  if (cached && !path) return cached;
  const file = path ?? resolve(process.cwd(), 'evaluation', 'model.json');
  const model = JSON.parse(readFileSync(file, 'utf8')) as ModelFile;
  if (!path) cached = model;
  return model;
}

/**
 * Build the feature vector.
 *
 * Order must match the exported `features` array exactly; a mismatch would silently
 * score the wrong weights against the wrong values, so buildFeatures asserts it.
 */
function buildFeatures(input: ScoringInput, names: readonly string[]): number[] {
  const values: Record<string, number> = {
    log_amount: Math.log10(Math.max(input.amountPaise, 1)),
    prior_success: input.priorSuccessCount,
    prior_failure: input.priorFailureCount,
    is_temporary_failure: input.diagnosis === 'TEMPORARY_BANK_OR_NETWORK_FAILURE' ? 1 : 0,
    is_insufficient_funds: input.diagnosis === 'INSUFFICIENT_FUNDS' ? 1 : 0,
    is_expired_method: input.diagnosis === 'EXPIRED_PAYMENT_METHOD' ? 1 : 0,
    is_abandonment: input.diagnosis === 'USER_ABANDONMENT' ? 1 : 0,
    attempt_number: input.attemptNumber,
    is_upi: input.paymentMethod === 'upi' ? 1 : 0,
    is_card: input.paymentMethod === 'card' ? 1 : 0,
  };

  return names.map((name) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`model expects feature "${name}", which score.ts does not compute`);
    }
    return value;
  });
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Probability this customer completes payment if contacted.
 *
 * Note what this is not: it plays no part in whether contact is *permitted*. The
 * policy engine decides that, and no score can override a block. This only informs
 * which action to take and whether the expected recovery justifies the contact.
 */
export function scoreRecoveryProbability(input: ScoringInput, model = loadModel()): number {
  const features = buildFeatures(input, model.features);
  const { mean, std } = model.standardisation;

  let z = model.intercept;
  for (const [index, value] of features.entries()) {
    const featureMean = mean[index] ?? 0;
    const featureStd = std[index] ?? 1;
    const coefficient = model.coefficients[index] ?? 0;
    z += coefficient * ((value - featureMean) / featureStd);
  }

  // Platt scaling, matching sklearn's sigmoid calibrator: p = 1 / (1 + exp(a*f + b))
  // where f is the uncalibrated decision value. Note sklearn's sign convention -- it
  // fits on the decision function directly, so the sigmoid is not negated here.
  const calibrated = sigmoid(-(model.calibration.a * z + model.calibration.b));

  // Clamp: a probability of exactly 0 or 1 is a claim the data cannot support.
  return Math.min(Math.max(calibrated, 0.001), 0.999);
}

/**
 * Why the model scored this case as it did, as a plain-language list.
 *
 * The largest contributions, in the units a merchant can act on. This is what makes a
 * linear model worth the accuracy it gives up.
 */
export function explainScore(input: ScoringInput, model = loadModel()): string[] {
  const features = buildFeatures(input, model.features);
  const { mean, std } = model.standardisation;

  const contributions = features.map((value, index) => ({
    feature: model.features[index] ?? '',
    contribution: (model.coefficients[index] ?? 0) * ((value - (mean[index] ?? 0)) / (std[index] ?? 1)),
  }));

  return contributions
    .filter((c) => Math.abs(c.contribution) > 0.05)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 4)
    .map((c) => `${c.feature} ${c.contribution > 0 ? 'raises' : 'lowers'} the estimate (${c.contribution.toFixed(2)})`);
}
