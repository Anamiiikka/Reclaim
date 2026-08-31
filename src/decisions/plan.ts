/**
 * Action planning: given a diagnosis and a policy verdict, choose exactly one
 * bounded action.
 *
 * The timing table is the interesting part. Contacting a customer immediately is
 * not always best — after a low-balance decline it is close to useless, and after a
 * transient network error it is close to essential. Those delays are policy, written
 * here once, rather than a number scattered through the codebase.
 */

import type { CaseSnapshot, Decision, Diagnosis, PlannedAction, PolicyDecision } from '../types.js';

interface Recipe {
  readonly action: PlannedAction['action'];
  readonly delayMinutes: number;
  readonly why: string;
}

/**
 * One recipe per diagnosis.
 *
 * Delays are chosen to match how each failure actually resolves — see RESPONSE_MODEL.md,
 * whose uplift curves encode the same judgment. The two must agree: a system that
 * always contacted immediately would score worse there, and should.
 */
const RECIPES: Readonly<Record<Diagnosis, Recipe>> = {
  // Transient: the customer wanted to pay and the rails failed them. Wait long
  // enough for the issue to clear, not so long that intent decays.
  TEMPORARY_BANK_OR_NETWORK_FAILURE: {
    action: 'SEND_PAYMENT_LINK',
    delayMinutes: 30,
    why: 'transient failure; a fresh link once the issue clears usually succeeds',
  },

  // Waiting is the entire intervention. Contacting at once just tells someone
  // they have no money, which they know.
  INSUFFICIENT_FUNDS: {
    action: 'DELAYED_RETRY_PROMPT',
    delayMinutes: 12 * 60,
    why: 'balance problems resolve with time; a later prompt outperforms an immediate one',
  },

  // The card will fail again no matter how often we ask. Offer a different rail.
  EXPIRED_PAYMENT_METHOD: {
    action: 'SUGGEST_ALTERNATE_METHOD',
    delayMinutes: 15,
    why: 'the stored method cannot succeed; offer UPI or another method instead',
  },

  // Intent was weakest here, so reach them while the session is still recent.
  USER_ABANDONMENT: {
    action: 'SEND_PAYMENT_LINK',
    delayMinutes: 60,
    why: 'abandoned checkout; a single resume link while the intent is still fresh',
  },

  // They may already be paying by another route. Contacting risks double payment.
  DUPLICATE_OR_REPEAT_ATTEMPT: {
    action: 'MERCHANT_ALERT',
    delayMinutes: 0,
    why: 'repeated attempts may already have succeeded elsewhere; merchant reviews rather than customer contact',
  },

  // Never contact. The customer may not be the account holder.
  SUSPICIOUS_ACTIVITY: {
    action: 'HUMAN_ESCALATION',
    delayMinutes: 0,
    why: 'fraud signals present; no automated contact, human review only',
  },

  // The customer cannot fix this. Telling them would be noise.
  MERCHANT_CONFIGURATION_ERROR: {
    action: 'MERCHANT_ALERT',
    delayMinutes: 0,
    why: 'merchant-side misconfiguration; the customer cannot act on it',
  },

  // We don't know why this failed, so take the least presumptuous action.
  UNKNOWN: {
    action: 'SEND_PAYMENT_LINK',
    delayMinutes: 120,
    why: 'cause unclear; a single low-pressure link after a longer delay',
  },
};

/** Below this, contacting costs more attention than the expected recovery is worth. */
export const MIN_RECOVERY_PROBABILITY = 0.15;

/**
 * Confidence below this means the diagnosis is a guess. We still act, but only via
 * the conservative UNKNOWN recipe rather than a diagnosis-specific one.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function planAction(c: CaseSnapshot, policy: PolicyDecision): PlannedAction {
  if (!policy.allowed) {
    // Fraud and merchant errors still deserve a human or a merchant alert even
    // though no customer contact is permitted — silence would lose the case.
    if (policy.blockReason === 'SUSPECTED_FRAUD') {
      return {
        action: 'HUMAN_ESCALATION',
        delayMinutes: 0,
        requiresApproval: false,
        rationale: 'blocked from contact by fraud signals; routed to human review',
      };
    }
    if (policy.blockReason === 'MERCHANT_APPROVAL_REQUIRED') {
      const recipe = RECIPES[c.diagnosis];
      return {
        action: recipe.action,
        delayMinutes: recipe.delayMinutes,
        requiresApproval: true,
        rationale: `${recipe.why}; held for merchant approval (high value)`,
      };
    }
    return {
      action: 'NO_ACTION',
      delayMinutes: 0,
      requiresApproval: false,
      rationale: `no action permitted: ${policy.blockReason ?? 'policy block'}`,
    };
  }

  // Acting on a guess with a diagnosis-specific recipe would be overconfident, so a
  // low-confidence diagnosis falls back to the UNKNOWN recipe.
  //
  // But "conservative" is not the same as "UNKNOWN". Where the specific recipe avoids
  // contacting the customer, the fallback must not overrule it: a suspected duplicate
  // sent a payment link invites a double payment, which is worse than the uncertainty
  // that triggered the fallback. Falling back may only ever reduce contact, never add it.
  //
  // Found by querying real decisions: three duplicate-attempt cases diagnosed by
  // heuristic (confidence 0.55) were being sent payment links.
  const specificRecipe = RECIPES[c.diagnosis];
  const specificAvoidsContact =
    specificRecipe.action === 'MERCHANT_ALERT' || specificRecipe.action === 'HUMAN_ESCALATION';
  const useConservative = c.diagnosisConfidence < LOW_CONFIDENCE_THRESHOLD && !specificAvoidsContact;
  const recipe = useConservative ? RECIPES.UNKNOWN : specificRecipe;

  // Contacting has a cost. Below the floor, doing nothing is the better decision.
  if (
    c.recoveryProbability !== null &&
    c.recoveryProbability < MIN_RECOVERY_PROBABILITY &&
    recipe.action !== 'MERCHANT_ALERT' &&
    recipe.action !== 'HUMAN_ESCALATION'
  ) {
    return {
      action: 'NO_ACTION',
      delayMinutes: 0,
      requiresApproval: false,
      rationale: `recovery probability ${(c.recoveryProbability * 100).toFixed(0)}% is below the ${(MIN_RECOVERY_PROBABILITY * 100).toFixed(0)}% floor; contact not justified`,
    };
  }

  return {
    action: recipe.action,
    delayMinutes: recipe.delayMinutes,
    requiresApproval: false,
    rationale: useConservative
      ? `${recipe.why} (diagnosis confidence ${c.diagnosisConfidence.toFixed(2)} is low, so the conservative recipe applies)`
      : recipe.why,
  };
}

/**
 * Assemble the human-readable explanation from structured decision data.
 *
 * Deliberately templated rather than model-generated: an explanation that can drift
 * from the decision it describes is worse than no explanation, and this text is what
 * a merchant will rely on when they ask why a customer was or wasn't contacted.
 */
export function explain(c: CaseSnapshot, policy: PolicyDecision, planned: PlannedAction): string {
  const rupees = (c.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const lines = [
    `₹${rupees} payment failed (${c.failureCode ?? 'no gateway code'}).`,
    `Diagnosed as ${c.diagnosis} with confidence ${c.diagnosisConfidence.toFixed(2)}.`,
  ];

  const blocked = policy.checks.filter((r) => !r.passed);
  if (blocked.length > 0) {
    lines.push(`Policy blocked: ${blocked.map((r) => `${r.rule} (${r.detail})`).join('; ')}.`);
  } else {
    lines.push(`All ${policy.checks.length} policy checks passed.`);
  }

  if (planned.action === 'NO_ACTION') {
    lines.push(`No action taken: ${planned.rationale}`);
  } else {
    const when = planned.delayMinutes === 0 ? 'immediately' : `after ${formatDelay(planned.delayMinutes)}`;
    lines.push(`Action: ${planned.action} ${when} — ${planned.rationale}`);
    if (planned.requiresApproval) {
      lines.push('Awaiting merchant approval before execution.');
    }
  }

  return lines.join(' ');
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** The full decision for one case: policy, plan and explanation together. */
export function decide(c: CaseSnapshot, policy: PolicyDecision): Decision {
  const planned = planAction(c, policy);
  return {
    caseId: c.caseId,
    diagnosis: c.diagnosis,
    policy,
    planned,
    explanation: explain(c, policy, planned),
  };
}
