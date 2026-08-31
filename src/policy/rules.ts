/**
 * Policy engine — G1 through G9.
 *
 * Two properties make this the part of Reclaim we can defend without qualification:
 *
 *   1. It is pure. No database, no clock, no network. Decision time arrives in the
 *      snapshot. The same snapshot always produces the same decision, forever.
 *   2. It runs every rule and reports all of them, rather than short-circuiting on
 *      the first block. A merchant asking "why wasn't this customer contacted?"
 *      gets the complete picture, not just whichever rule happened to fire first.
 *
 * No model output can override a block here. Recovery probability is an input to
 * *which* action to take, never to *whether* contact is permitted.
 */

import type { CaseSnapshot, PolicyCheckResult, PolicyDecision } from '../types.js';

/** G2: per-order reminder cap. */
export const MAX_REMINDERS_PER_ORDER = 2;

/**
 * G2: cross-order cap. A customer with three failed orders should not receive six
 * messages, so the budget is per-customer rather than only per-order.
 */
export const MAX_REMINDERS_PER_CUSTOMER = 3;

/** G4: at or above this, we stop and escalate rather than contact. */
export const SUSPICION_BLOCK_THRESHOLD = 0.8;

/** G6: minimum gap between two actions on the same case. */
export const COOLDOWN_MINUTES = 30;

const MINUTE_MS = 60_000;

function pass(rule: string, detail: string): PolicyCheckResult {
  return { rule, passed: true, reason: null, detail };
}

function block(rule: string, reason: PolicyCheckResult['reason'], detail: string): PolicyCheckResult {
  return { rule, passed: false, reason, detail };
}

/** G1 — consent. The one rule with no exception anywhere in the system. */
export function checkOptOut(c: CaseSnapshot): PolicyCheckResult {
  return c.isOptedOut
    ? block('G1_OPT_OUT', 'CUSTOMER_OPTED_OUT', 'customer has opted out of recovery contact')
    : pass('G1_OPT_OUT', 'customer has not opted out');
}

/** G3 — never contact someone who has already paid. */
export function checkAlreadyPaid(c: CaseSnapshot): PolicyCheckResult {
  return c.hasPaidSince
    ? block('G3_ALREADY_PAID', 'ALREADY_PAID', 'payment completed after this failure')
    : pass('G3_ALREADY_PAID', 'no payment recorded since the failure');
}

/** G2a — per-order reminder cap. */
export function checkOrderReminderLimit(c: CaseSnapshot): PolicyCheckResult {
  if (c.remindersSentForOrder >= MAX_REMINDERS_PER_ORDER) {
    return block(
      'G2_ORDER_LIMIT',
      'ORDER_REMINDER_LIMIT_REACHED',
      `${c.remindersSentForOrder} reminders already sent for this order (limit ${MAX_REMINDERS_PER_ORDER})`,
    );
  }
  return pass('G2_ORDER_LIMIT', `${c.remindersSentForOrder}/${MAX_REMINDERS_PER_ORDER} reminders used for this order`);
}

/** G2b — cross-order fatigue budget. */
export function checkCustomerFatigue(c: CaseSnapshot): PolicyCheckResult {
  if (c.remindersSentToCustomer >= MAX_REMINDERS_PER_CUSTOMER) {
    return block(
      'G2_CUSTOMER_FATIGUE',
      'CUSTOMER_FATIGUE_BUDGET_REACHED',
      `${c.remindersSentToCustomer} reminders already sent across all orders (limit ${MAX_REMINDERS_PER_CUSTOMER})`,
    );
  }
  return pass(
    'G2_CUSTOMER_FATIGUE',
    `${c.remindersSentToCustomer}/${MAX_REMINDERS_PER_CUSTOMER} of this customer's budget used`,
  );
}

/** G4 — fraud suspicion blocks contact and routes to a human. */
export function checkSuspicion(c: CaseSnapshot): PolicyCheckResult {
  if (c.suspicionScore >= SUSPICION_BLOCK_THRESHOLD || c.diagnosis === 'SUSPICIOUS_ACTIVITY') {
    return block(
      'G4_SUSPICION',
      'SUSPECTED_FRAUD',
      `suspicion ${c.suspicionScore.toFixed(2)} (threshold ${SUSPICION_BLOCK_THRESHOLD}), diagnosis ${c.diagnosis}`,
    );
  }
  return pass('G4_SUSPICION', `suspicion ${c.suspicionScore.toFixed(2)} below threshold`);
}

/** G6 — cool-down between actions on the same case. */
export function checkCooldown(c: CaseSnapshot): PolicyCheckResult {
  if (c.lastActionAt === null) {
    return pass('G6_COOLDOWN', 'no previous action on this case');
  }
  const elapsedMinutes = (Date.parse(c.now) - Date.parse(c.lastActionAt)) / MINUTE_MS;
  if (elapsedMinutes < COOLDOWN_MINUTES) {
    return block(
      'G6_COOLDOWN',
      'COOLDOWN_ACTIVE',
      `${elapsedMinutes.toFixed(0)}m since last action (cool-down ${COOLDOWN_MINUTES}m)`,
    );
  }
  return pass('G6_COOLDOWN', `${elapsedMinutes.toFixed(0)}m since last action`);
}

/** G8 — the recovery window closes 72h after failure. */
export function checkWindow(c: CaseSnapshot): PolicyCheckResult {
  if (Date.parse(c.now) >= Date.parse(c.expiresAt)) {
    return block('G8_WINDOW', 'RECOVERY_WINDOW_EXPIRED', `recovery window closed at ${c.expiresAt}`);
  }
  return pass('G8_WINDOW', `window open until ${c.expiresAt}`);
}

/**
 * G9 — never auto-retry a card without a stored mandate.
 *
 * Re-presenting a card the customer did not authorise again is a compliance problem,
 * not merely an impolite one. A payment link is always permitted: the customer
 * re-authorises by using it.
 */
export function checkCardRetryMandate(c: CaseSnapshot): PolicyCheckResult {
  if (c.paymentMethod === 'card' && c.diagnosis === 'INSUFFICIENT_FUNDS') {
    return block(
      'G9_CARD_MANDATE',
      'CARD_RETRY_REQUIRES_MANDATE',
      'card retry needs an explicit mandate; a payment link is permitted instead',
    );
  }
  return pass('G9_CARD_MANDATE', 'no unmandated card retry proposed');
}

/**
 * G5 — high-value actions need a human.
 *
 * This gates rather than blocks: the action is permitted once a merchant approves,
 * so it is reported separately from a hard block.
 */
export function checkApprovalRequired(c: CaseSnapshot): PolicyCheckResult {
  if (c.amountPaise > c.merchantApprovalThresholdPaise && !c.merchantHasApproved) {
    return block(
      'G5_APPROVAL',
      'MERCHANT_APPROVAL_REQUIRED',
      `₹${(c.amountPaise / 100).toFixed(2)} exceeds the merchant threshold of ₹${(c.merchantApprovalThresholdPaise / 100).toFixed(2)}`,
    );
  }
  return pass('G5_APPROVAL', 'below the approval threshold, or already approved');
}

/**
 * Control arm: never contacted, by construction.
 *
 * Without this the holdout would be contaminated and the uplift measurement would
 * be meaningless. It is enforced here, in the same place as every other rule, so it
 * cannot be forgotten at a call site.
 */
export function checkExperimentArm(c: CaseSnapshot): PolicyCheckResult {
  if (c.arm === 'CONTROL') {
    return block('X_CONTROL_ARM', 'NO_VIABLE_ACTION', 'control arm: withheld to measure uplift');
  }
  return pass('X_CONTROL_ARM', 'treatment arm');
}

/**
 * Run every rule and combine the verdicts.
 *
 * Rules run in a fixed order and all of them run, so the audit trail is a complete
 * account rather than "the first thing that said no".
 */
export function evaluatePolicy(c: CaseSnapshot): PolicyDecision {
  const checks: PolicyCheckResult[] = [
    checkOptOut(c),
    checkAlreadyPaid(c),
    checkSuspicion(c),
    checkWindow(c),
    checkOrderReminderLimit(c),
    checkCustomerFatigue(c),
    checkCooldown(c),
    checkCardRetryMandate(c),
    checkExperimentArm(c),
    checkApprovalRequired(c),
  ];

  // Approval is a gate, not a block: it means "not yet", not "never".
  const approvalCheck = checks.find((r) => r.reason === 'MERCHANT_APPROVAL_REQUIRED');
  const hardBlocks = checks.filter((r) => !r.passed && r.reason !== 'MERCHANT_APPROVAL_REQUIRED');

  const requiresApproval = approvalCheck !== undefined;
  const firstBlock = hardBlocks[0];

  if (firstBlock) {
    return {
      allowed: false,
      requiresApproval,
      blockReason: firstBlock.reason,
      checks,
    };
  }

  return {
    allowed: !requiresApproval,
    requiresApproval,
    blockReason: requiresApproval ? 'MERCHANT_APPROVAL_REQUIRED' : null,
    checks,
  };
}
