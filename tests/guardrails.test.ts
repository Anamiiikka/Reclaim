/**
 * G1–G9 guardrail suite.
 *
 * These tests are the project's central claim, so they are written adversarially:
 * each one tries to make the policy engine do the wrong thing, and passes only when
 * it refuses. The count of adversarial cases surviving here is what we report.
 */

import { describe, expect, it } from 'vitest';

import { decide } from '../src/decisions/plan.js';
import {
  COOLDOWN_MINUTES,
  MAX_REMINDERS_PER_CUSTOMER,
  MAX_REMINDERS_PER_ORDER,
  SUSPICION_BLOCK_THRESHOLD,
  evaluatePolicy,
} from '../src/policy/rules.js';
import type { CaseSnapshot } from '../src/types.js';

const NOW = '2026-08-15T12:00:00.000Z';

/** A case where everything is permitted, so each test can break exactly one thing. */
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
    now: NOW,
    ...overrides,
  };
}

/** Actions that put a message in front of a customer. */
const CUSTOMER_FACING = ['SEND_PAYMENT_LINK', 'SUGGEST_ALTERNATE_METHOD', 'DELAYED_RETRY_PROMPT'];

function contactsCustomer(snapshot: CaseSnapshot): boolean {
  const decision = decide(snapshot, evaluatePolicy(snapshot));
  return CUSTOMER_FACING.includes(decision.planned.action) && !decision.planned.requiresApproval;
}

describe('the baseline case is actually permitted', () => {
  it('contacts a straightforward recoverable customer', () => {
    // Without this, every other test could pass for the wrong reason.
    expect(contactsCustomer(baseCase())).toBe(true);
  });
});

describe('G1 — opted-out customers are never contacted', () => {
  it('blocks contact', () => {
    expect(contactsCustomer(baseCase({ isOptedOut: true }))).toBe(false);
  });

  it('blocks even when every other signal is ideal', () => {
    const snapshot = baseCase({
      isOptedOut: true,
      recoveryProbability: 0.99,
      priorSuccessCount: 20,
      diagnosisConfidence: 0.99,
    });
    expect(contactsCustomer(snapshot)).toBe(false);
    expect(evaluatePolicy(snapshot).blockReason).toBe('CUSTOMER_OPTED_OUT');
  });

  it('blocks even for a high-value order a merchant approved', () => {
    // Approval covers spending money, not overriding consent.
    const snapshot = baseCase({ isOptedOut: true, amountPaise: 5_000_000, merchantHasApproved: true });
    expect(contactsCustomer(snapshot)).toBe(false);
  });
});

describe('G2 — reminder caps', () => {
  it('allows a reminder below the per-order cap', () => {
    expect(contactsCustomer(baseCase({ remindersSentForOrder: MAX_REMINDERS_PER_ORDER - 1 }))).toBe(true);
  });

  it('blocks at the per-order cap', () => {
    expect(contactsCustomer(baseCase({ remindersSentForOrder: MAX_REMINDERS_PER_ORDER }))).toBe(false);
  });

  it('blocks beyond the per-order cap', () => {
    expect(contactsCustomer(baseCase({ remindersSentForOrder: 99 }))).toBe(false);
  });

  it('blocks at the cross-order fatigue budget even on a fresh order', () => {
    // The case this rule exists for: three failed orders must not mean six messages.
    const snapshot = baseCase({
      remindersSentForOrder: 0,
      remindersSentToCustomer: MAX_REMINDERS_PER_CUSTOMER,
    });
    expect(contactsCustomer(snapshot)).toBe(false);
    expect(evaluatePolicy(snapshot).blockReason).toBe('CUSTOMER_FATIGUE_BUDGET_REACHED');
  });
});

describe('G3 — customers who already paid are never contacted', () => {
  it('blocks contact once payment is recorded', () => {
    expect(contactsCustomer(baseCase({ hasPaidSince: true }))).toBe(false);
  });

  it('blocks even mid-recovery with reminders still available', () => {
    const snapshot = baseCase({ hasPaidSince: true, remindersSentForOrder: 1 });
    expect(evaluatePolicy(snapshot).allowed).toBe(false);
  });
});

describe('G4 — suspected fraud stops automation', () => {
  it('blocks at the threshold', () => {
    expect(contactsCustomer(baseCase({ suspicionScore: SUSPICION_BLOCK_THRESHOLD }))).toBe(false);
  });

  it('allows just below the threshold', () => {
    expect(contactsCustomer(baseCase({ suspicionScore: SUSPICION_BLOCK_THRESHOLD - 0.01 }))).toBe(true);
  });

  it('blocks on the diagnosis alone even with a low score', () => {
    // A fraud diagnosis can come from signals the score doesn't capture.
    expect(contactsCustomer(baseCase({ diagnosis: 'SUSPICIOUS_ACTIVITY', suspicionScore: 0.1 }))).toBe(false);
  });

  it('escalates to a human rather than falling silent', () => {
    const snapshot = baseCase({ suspicionScore: 0.95 });
    const decision = decide(snapshot, evaluatePolicy(snapshot));
    expect(decision.planned.action).toBe('HUMAN_ESCALATION');
  });
});

describe('G5 — high-value actions need merchant approval', () => {
  it('gates an order above the threshold', () => {
    const snapshot = baseCase({ amountPaise: 2_000_000, merchantApprovalThresholdPaise: 1_000_000 });
    const policy = evaluatePolicy(snapshot);
    expect(policy.requiresApproval).toBe(true);
    expect(policy.allowed).toBe(false);
    expect(contactsCustomer(snapshot)).toBe(false);
  });

  it('permits it once approved', () => {
    const snapshot = baseCase({
      amountPaise: 2_000_000,
      merchantApprovalThresholdPaise: 1_000_000,
      merchantHasApproved: true,
    });
    expect(evaluatePolicy(snapshot).allowed).toBe(true);
    expect(contactsCustomer(snapshot)).toBe(true);
  });

  it('does not gate exactly at the threshold', () => {
    // The rule is "above", so the boundary itself must pass.
    const snapshot = baseCase({ amountPaise: 1_000_000, merchantApprovalThresholdPaise: 1_000_000 });
    expect(evaluatePolicy(snapshot).requiresApproval).toBe(false);
  });

  it('respects a stricter per-merchant threshold', () => {
    const snapshot = baseCase({ amountPaise: 600_000, merchantApprovalThresholdPaise: 500_000 });
    expect(evaluatePolicy(snapshot).requiresApproval).toBe(true);
  });

  it('keeps the planned action but withholds it pending approval', () => {
    const snapshot = baseCase({ amountPaise: 2_000_000 });
    const decision = decide(snapshot, evaluatePolicy(snapshot));
    expect(decision.planned.requiresApproval).toBe(true);
    expect(decision.planned.action).toBe('SEND_PAYMENT_LINK');
  });
});

describe('G6 — cool-down between actions', () => {
  it('blocks inside the window', () => {
    const snapshot = baseCase({ lastActionAt: '2026-08-15T11:45:00.000Z' }); // 15m ago
    expect(contactsCustomer(snapshot)).toBe(false);
    expect(evaluatePolicy(snapshot).blockReason).toBe('COOLDOWN_ACTIVE');
  });

  it('allows once the window has passed', () => {
    const snapshot = baseCase({ lastActionAt: '2026-08-15T11:00:00.000Z' }); // 60m ago
    expect(contactsCustomer(snapshot)).toBe(true);
  });

  it('allows exactly at the boundary', () => {
    const boundary = new Date(Date.parse(NOW) - COOLDOWN_MINUTES * 60_000).toISOString();
    expect(contactsCustomer(baseCase({ lastActionAt: boundary }))).toBe(true);
  });
});

describe('G8 — the recovery window closes', () => {
  it('blocks after expiry', () => {
    const snapshot = baseCase({ expiresAt: '2026-08-15T11:00:00.000Z' }); // an hour ago
    expect(contactsCustomer(snapshot)).toBe(false);
    expect(evaluatePolicy(snapshot).blockReason).toBe('RECOVERY_WINDOW_EXPIRED');
  });

  it('blocks exactly at expiry', () => {
    expect(contactsCustomer(baseCase({ expiresAt: NOW }))).toBe(false);
  });

  it('allows a minute before expiry', () => {
    const snapshot = baseCase({ expiresAt: '2026-08-15T12:01:00.000Z' });
    expect(contactsCustomer(snapshot)).toBe(true);
  });
});

describe('G9 — no unmandated card retry', () => {
  it('blocks a card retry after a low-balance decline', () => {
    const snapshot = baseCase({ paymentMethod: 'card', diagnosis: 'INSUFFICIENT_FUNDS' });
    expect(evaluatePolicy(snapshot).blockReason).toBe('CARD_RETRY_REQUIRES_MANDATE');
  });

  it('permits the same case on UPI', () => {
    // The restriction is about re-presenting a card, not about the diagnosis.
    const snapshot = baseCase({ paymentMethod: 'upi', diagnosis: 'INSUFFICIENT_FUNDS' });
    expect(evaluatePolicy(snapshot).allowed).toBe(true);
  });
});

describe('control arm is never contacted', () => {
  it('withholds contact so uplift stays measurable', () => {
    // If this leaked, every recovery number would be meaningless.
    expect(contactsCustomer(baseCase({ arm: 'CONTROL' }))).toBe(false);
  });

  it('withholds even for the most promising case', () => {
    const snapshot = baseCase({ arm: 'CONTROL', recoveryProbability: 0.99, priorSuccessCount: 50 });
    expect(contactsCustomer(snapshot)).toBe(false);
  });
});

describe('hopeless categories are never given customer contact', () => {
  it('routes a merchant configuration error to the merchant', () => {
    const snapshot = baseCase({ diagnosis: 'MERCHANT_CONFIGURATION_ERROR', failureCode: 'MERCHANT_KEY_INVALID' });
    const decision = decide(snapshot, evaluatePolicy(snapshot));
    expect(decision.planned.action).toBe('MERCHANT_ALERT');
    expect(contactsCustomer(snapshot)).toBe(false);
  });

  it('routes duplicate attempts to merchant review', () => {
    const snapshot = baseCase({ diagnosis: 'DUPLICATE_OR_REPEAT_ATTEMPT', failureCode: 'DUPLICATE_ATTEMPT' });
    expect(contactsCustomer(snapshot)).toBe(false);
  });
});

describe('low confidence never introduces customer contact', () => {
  // Regression. A heuristic diagnosis (confidence 0.55) fell back to the "conservative"
  // UNKNOWN recipe, which sends a payment link — so three real duplicate-attempt cases
  // were contacted. For a suspected duplicate that is the *least* safe action: the
  // customer may already be paying elsewhere. Falling back must only reduce contact.
  it('does not contact a low-confidence duplicate attempt', () => {
    const snapshot = baseCase({ diagnosis: 'DUPLICATE_OR_REPEAT_ATTEMPT', diagnosisConfidence: 0.55 });
    const decision = decide(snapshot, evaluatePolicy(snapshot));
    expect(decision.planned.action).toBe('MERCHANT_ALERT');
    expect(contactsCustomer(snapshot)).toBe(false);
  });

  it('does not contact a low-confidence merchant configuration error', () => {
    const snapshot = baseCase({ diagnosis: 'MERCHANT_CONFIGURATION_ERROR', diagnosisConfidence: 0.55 });
    expect(contactsCustomer(snapshot)).toBe(false);
  });

  it('still applies the conservative recipe where contact was already permitted', () => {
    // The fallback must keep working for genuinely contactable diagnoses.
    const snapshot = baseCase({ diagnosis: 'INSUFFICIENT_FUNDS', paymentMethod: 'upi', diagnosisConfidence: 0.55 });
    const decision = decide(snapshot, evaluatePolicy(snapshot));
    expect(decision.planned.rationale).toContain('confidence');
    expect(contactsCustomer(snapshot)).toBe(true);
  });
});

describe('every rule reports, not just the first failure', () => {
  it('records all ten checks even when one blocks', () => {
    const policy = evaluatePolicy(baseCase({ isOptedOut: true }));
    expect(policy.checks).toHaveLength(10);
  });

  it('shows every violated rule when several fail at once', () => {
    // A merchant asking "why?" should see the whole picture.
    const policy = evaluatePolicy(
      baseCase({ isOptedOut: true, hasPaidSince: true, suspicionScore: 0.9, remindersSentForOrder: 5 }),
    );
    const failed = policy.checks.filter((r) => !r.passed).map((r) => r.rule);
    expect(failed).toContain('G1_OPT_OUT');
    expect(failed).toContain('G3_ALREADY_PAID');
    expect(failed).toContain('G4_SUSPICION');
    expect(failed).toContain('G2_ORDER_LIMIT');
  });

  it('gives every check a human-readable detail', () => {
    for (const check of evaluatePolicy(baseCase()).checks) {
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('decisions are deterministic', () => {
  it('produces an identical decision for an identical snapshot', () => {
    // The whole replay story depends on this.
    const snapshot = baseCase();
    const a = decide(snapshot, evaluatePolicy(snapshot));
    const b = decide(snapshot, evaluatePolicy(snapshot));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never reads the wall clock', () => {
    // Decision time comes from the snapshot; a real clock would make replay impossible.
    const snapshot = baseCase({ now: '2030-01-01T00:00:00.000Z', expiresAt: '2029-12-31T00:00:00.000Z' });
    expect(evaluatePolicy(snapshot).blockReason).toBe('RECOVERY_WINDOW_EXPIRED');
  });
});
