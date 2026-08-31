/**
 * Action planner tests.
 *
 * The timing decisions are the substance here: the same failure contacted at the
 * wrong moment is a wasted message, and the recipes encode that judgment.
 */

import { describe, expect, it } from 'vitest';

import { MIN_RECOVERY_PROBABILITY, decide, explain, planAction } from '../src/decisions/plan.js';
import { evaluatePolicy } from '../src/policy/rules.js';
import type { CaseSnapshot } from '../src/types.js';

function baseCase(overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: 'rcv_0001',
    customerId: 'cus_0001',
    merchantId: 'mer_0001',
    orderId: 'ord_0001',
    amountPaise: 149_900,
    paymentMethod: 'upi',
    attemptStatus: 'FAILED',
    failureCode: 'GATEWAY_TIMEOUT',
    checkoutStage: 'payment',
    diagnosis: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',
    diagnosisConfidence: 0.99,
    recoveryProbability: 0.6,
    isOptedOut: false,
    hasPaidSince: false,
    suspicionScore: 0.1,
    priorSuccessCount: 2,
    priorFailureCount: 0,
    remindersSentForOrder: 0,
    remindersSentToCustomer: 0,
    merchantApprovalThresholdPaise: 1_000_000,
    merchantHasApproved: false,
    failedAt: '2026-08-15T10:00:00.000Z',
    expiresAt: '2026-08-18T10:00:00.000Z',
    lastActionAt: null,
    arm: 'TREATMENT',
    now: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

function plan(overrides: Partial<CaseSnapshot> = {}) {
  const snapshot = baseCase(overrides);
  return planAction(snapshot, evaluatePolicy(snapshot));
}

describe('each diagnosis gets an appropriate action', () => {
  it('sends a link promptly after a transient failure', () => {
    const result = plan({ diagnosis: 'TEMPORARY_BANK_OR_NETWORK_FAILURE' });
    expect(result.action).toBe('SEND_PAYMENT_LINK');
    expect(result.delayMinutes).toBeLessThanOrEqual(60);
  });

  it('waits hours after a low-balance decline', () => {
    // Contacting immediately tells someone they have no money, which they know.
    // RESPONSE_MODEL.md encodes the same judgment in its uplift curve.
    const result = plan({ diagnosis: 'INSUFFICIENT_FUNDS' });
    expect(result.delayMinutes).toBeGreaterThanOrEqual(6 * 60);
  });

  it('offers another method when the card cannot succeed', () => {
    expect(plan({ diagnosis: 'EXPIRED_PAYMENT_METHOD' }).action).toBe('SUGGEST_ALTERNATE_METHOD');
  });

  it('alerts the merchant rather than the customer for a config error', () => {
    expect(plan({ diagnosis: 'MERCHANT_CONFIGURATION_ERROR' }).action).toBe('MERCHANT_ALERT');
  });

  it('escalates fraud to a human', () => {
    expect(plan({ diagnosis: 'SUSPICIOUS_ACTIVITY' }).action).toBe('HUMAN_ESCALATION');
  });

  it('acts conservatively when the cause is unknown', () => {
    const result = plan({ diagnosis: 'UNKNOWN', diagnosisConfidence: 0.3 });
    expect(result.delayMinutes).toBeGreaterThanOrEqual(60);
  });
});

describe('low confidence falls back to the conservative recipe', () => {
  it('ignores the diagnosis-specific timing when the diagnosis is a guess', () => {
    const confident = plan({ diagnosis: 'INSUFFICIENT_FUNDS', diagnosisConfidence: 0.99 });
    const guess = plan({ diagnosis: 'INSUFFICIENT_FUNDS', diagnosisConfidence: 0.4 });
    expect(guess.delayMinutes).not.toBe(confident.delayMinutes);
    expect(guess.rationale).toContain('confidence');
  });
});

describe('the recovery-probability floor', () => {
  it('declines to contact when recovery is very unlikely', () => {
    const result = plan({ recoveryProbability: MIN_RECOVERY_PROBABILITY - 0.01 });
    expect(result.action).toBe('NO_ACTION');
  });

  it('contacts just above the floor', () => {
    expect(plan({ recoveryProbability: MIN_RECOVERY_PROBABILITY + 0.01 }).action).toBe('SEND_PAYMENT_LINK');
  });

  it('still alerts the merchant regardless of probability', () => {
    // The floor is about not bothering customers; merchants still need to know.
    const result = plan({ diagnosis: 'MERCHANT_CONFIGURATION_ERROR', recoveryProbability: 0.01 });
    expect(result.action).toBe('MERCHANT_ALERT');
  });

  it('acts normally when no probability has been scored yet', () => {
    expect(plan({ recoveryProbability: null }).action).toBe('SEND_PAYMENT_LINK');
  });
});

describe('explanations', () => {
  it('names the amount, diagnosis and action', () => {
    const snapshot = baseCase();
    const text = explain(snapshot, evaluatePolicy(snapshot), planAction(snapshot, evaluatePolicy(snapshot)));
    expect(text).toContain('1,499.00');
    expect(text).toContain('TEMPORARY_BANK_OR_NETWORK_FAILURE');
    expect(text).toContain('SEND_PAYMENT_LINK');
  });

  it('names the rule that blocked, so a merchant can see why', () => {
    const snapshot = baseCase({ isOptedOut: true });
    const text = explain(snapshot, evaluatePolicy(snapshot), planAction(snapshot, evaluatePolicy(snapshot)));
    expect(text).toContain('G1_OPT_OUT');
    expect(text).toContain('opted out');
  });

  it('says when approval is pending', () => {
    const snapshot = baseCase({ amountPaise: 5_000_000 });
    const text = explain(snapshot, evaluatePolicy(snapshot), planAction(snapshot, evaluatePolicy(snapshot)));
    expect(text).toContain('approval');
  });

  it('contains no placeholder text', () => {
    // Templated explanations are only trustworthy if they are actually filled in.
    for (const diagnosis of ['INSUFFICIENT_FUNDS', 'USER_ABANDONMENT', 'UNKNOWN'] as const) {
      const snapshot = baseCase({ diagnosis });
      const text = explain(snapshot, evaluatePolicy(snapshot), planAction(snapshot, evaluatePolicy(snapshot)));
      expect(text).not.toMatch(/undefined|NaN|\[object|null/);
    }
  });
});

describe('decisions are reproducible', () => {
  it('serialises identically across repeated runs', () => {
    const snapshot = baseCase();
    const first = JSON.stringify(decide(snapshot, evaluatePolicy(snapshot)));
    for (let i = 0; i < 20; i++) {
      expect(JSON.stringify(decide(snapshot, evaluatePolicy(snapshot)))).toBe(first);
    }
  });

  it('carries the full policy trail into the decision', () => {
    const snapshot = baseCase();
    expect(decide(snapshot, evaluatePolicy(snapshot)).policy.checks).toHaveLength(10);
  });
});
