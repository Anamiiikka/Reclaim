/**
 * Failure diagnosis.
 *
 * Deliberately boring: a gateway failure code is a fact, and mapping a fact to a
 * category is a lookup, not an inference problem. Reaching for a model here would
 * add nondeterminism and a failure mode without adding accuracy.
 *
 * The model earns its place only where the code is missing or unrecognised — see
 * diagnoseAmbiguous below.
 */

import type { AttemptStatus, Diagnosis } from '../types.js';

/**
 * Gateway code → cause. Codes are normalised (uppercase, trimmed) before lookup,
 * because gateways are not consistent about case.
 */
const CODE_MAP: Readonly<Record<string, Diagnosis>> = {
  GATEWAY_TIMEOUT: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  ISSUER_UNAVAILABLE: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  NETWORK_ERROR: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  BANK_TIMEOUT: 'TEMPORARY_BANK_OR_NETWORK_FAILURE',

  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  LOW_BALANCE: 'INSUFFICIENT_FUNDS',

  CARD_EXPIRED: 'EXPIRED_PAYMENT_METHOD',
  INVALID_CARD: 'EXPIRED_PAYMENT_METHOD',
  CARD_DECLINED_PERMANENT: 'EXPIRED_PAYMENT_METHOD',

  USER_DROPPED: 'USER_ABANDONMENT',
  USER_CANCELLED: 'USER_ABANDONMENT',

  DUPLICATE_ATTEMPT: 'DUPLICATE_OR_REPEAT_ATTEMPT',

  RISK_BLOCKED: 'SUSPICIOUS_ACTIVITY',
  VELOCITY_EXCEEDED: 'SUSPICIOUS_ACTIVITY',
  FRAUD_SUSPECTED: 'SUSPICIOUS_ACTIVITY',

  MERCHANT_KEY_INVALID: 'MERCHANT_CONFIGURATION_ERROR',
  CURRENCY_UNSUPPORTED: 'MERCHANT_CONFIGURATION_ERROR',
  MERCHANT_ACCOUNT_INACTIVE: 'MERCHANT_CONFIGURATION_ERROR',
};

export interface DiagnosisInput {
  readonly failureCode: string | null;
  readonly attemptStatus: AttemptStatus;
  readonly checkoutStage: string | null;
  readonly attemptNumber: number;
  readonly suspicionScore: number;
}

export interface DiagnosisResult {
  readonly diagnosis: Diagnosis;
  readonly confidence: number;
  /** Which path produced this, so the audit trail can show the reasoning. */
  readonly source: 'CODE_MAP' | 'STATUS_INFERENCE' | 'HEURISTIC' | 'FALLBACK';
  readonly detail: string;
}

/**
 * Confidence values are ordinal, not calibrated probabilities: they rank how much
 * evidence stands behind a label so that downstream code (and a human reading the
 * audit log) can tell a lookup from a guess. They are not used as probabilities.
 */
const CONFIDENCE = {
  EXACT_CODE: 0.99,
  STATUS_INFERRED: 0.9,
  HEURISTIC: 0.55,
  UNKNOWN: 0.3,
} as const;

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  // Fraud signals outrank the gateway code. A stolen card that declines for
  // "insufficient funds" is still fraud, and treating it as a recoverable
  // low-balance case would mean contacting an attacker.
  if (input.suspicionScore >= 0.8) {
    return {
      diagnosis: 'SUSPICIOUS_ACTIVITY',
      confidence: CONFIDENCE.STATUS_INFERRED,
      source: 'HEURISTIC',
      detail: `suspicion score ${input.suspicionScore.toFixed(2)} overrides the gateway code`,
    };
  }

  const code = input.failureCode?.trim().toUpperCase() ?? '';
  const mapped = code ? CODE_MAP[code] : undefined;
  if (mapped) {
    return {
      diagnosis: mapped,
      confidence: CONFIDENCE.EXACT_CODE,
      source: 'CODE_MAP',
      detail: `gateway code ${code}`,
    };
  }

  // No code at all. An abandoned checkout never produces one — the customer simply
  // left — so the status itself is the evidence.
  if (input.attemptStatus === 'ABANDONED') {
    return {
      diagnosis: 'USER_ABANDONMENT',
      confidence: CONFIDENCE.STATUS_INFERRED,
      source: 'STATUS_INFERENCE',
      detail: `checkout abandoned at stage "${input.checkoutStage ?? 'unknown'}"`,
    };
  }

  return diagnoseAmbiguous(input, code);
}

/**
 * Unrecognised or missing gateway code.
 *
 * These heuristics are weak by construction, and they say so through low confidence.
 * The point is not to be right — it is to avoid pretending certainty we don't have,
 * so the action planner can prefer a conservative action.
 */
function diagnoseAmbiguous(input: DiagnosisInput, code: string): DiagnosisResult {
  // Repeated failures on one order look like a systemic block rather than bad luck.
  if (input.attemptNumber >= 3) {
    return {
      diagnosis: 'DUPLICATE_OR_REPEAT_ATTEMPT',
      confidence: CONFIDENCE.HEURISTIC,
      source: 'HEURISTIC',
      detail: `attempt ${input.attemptNumber} on the same order with unrecognised code "${code}"`,
    };
  }

  // Failing before the payment step usually means the customer never really tried.
  if (input.checkoutStage && input.checkoutStage !== 'payment') {
    return {
      diagnosis: 'USER_ABANDONMENT',
      confidence: CONFIDENCE.HEURISTIC,
      source: 'HEURISTIC',
      detail: `failed at stage "${input.checkoutStage}", before payment`,
    };
  }

  return {
    diagnosis: 'UNKNOWN',
    confidence: CONFIDENCE.UNKNOWN,
    source: 'FALLBACK',
    detail: code ? `unrecognised gateway code "${code}"` : 'no gateway code supplied',
  };
}

/** Exposed for tests and for the evaluation harness's coverage report. */
export function knownFailureCodes(): readonly string[] {
  return Object.keys(CODE_MAP);
}
