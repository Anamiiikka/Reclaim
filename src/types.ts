/**
 * Shared vocabulary for Reclaim's decision layer.
 *
 * Money is always paise (integer). Never floats, never rupees: ₹1,499.00 is 149900.
 */

export const DIAGNOSES = [
  'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  'INSUFFICIENT_FUNDS',
  'EXPIRED_PAYMENT_METHOD',
  'USER_ABANDONMENT',
  'DUPLICATE_OR_REPEAT_ATTEMPT',
  'SUSPICIOUS_ACTIVITY',
  'MERCHANT_CONFIGURATION_ERROR',
  'UNKNOWN',
] as const;
export type Diagnosis = (typeof DIAGNOSES)[number];

export const ACTIONS = [
  'SEND_PAYMENT_LINK',
  'SUGGEST_ALTERNATE_METHOD',
  'DELAYED_RETRY_PROMPT',
  'MERCHANT_ALERT',
  'HUMAN_ESCALATION',
  'NO_ACTION',
] as const;
export type ActionType = (typeof ACTIONS)[number];

export type AttemptStatus = 'SUCCESS' | 'FAILED' | 'ABANDONED' | 'PENDING';

/** Every reason a policy check can block or gate an action. */
export const BLOCK_REASONS = [
  'CUSTOMER_OPTED_OUT',
  'ORDER_REMINDER_LIMIT_REACHED',
  'CUSTOMER_FATIGUE_BUDGET_REACHED',
  'ALREADY_PAID',
  'SUSPECTED_FRAUD',
  'COOLDOWN_ACTIVE',
  'RECOVERY_WINDOW_EXPIRED',
  'MERCHANT_APPROVAL_REQUIRED',
  'NO_VIABLE_ACTION',
  'CARD_RETRY_REQUIRES_MANDATE',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Everything the decision layer is allowed to see about a case.
 *
 * This is deliberately a plain snapshot rather than a DB handle: the policy engine
 * must be pure, and an audit record of this object must be enough to replay the
 * decision exactly. If a field isn't here, it cannot influence a decision.
 *
 * Note what is absent: any simulated outcome. Ground truth never reaches this type.
 */
export interface CaseSnapshot {
  readonly caseId: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly orderId: string;

  readonly amountPaise: number;
  readonly paymentMethod: string;
  readonly attemptStatus: AttemptStatus;
  readonly failureCode: string | null;
  readonly checkoutStage: string | null;

  readonly diagnosis: Diagnosis;
  readonly diagnosisConfidence: number;

  /** Probability the customer completes if contacted. Null until Phase 4 scores it. */
  readonly recoveryProbability: number | null;

  readonly isOptedOut: boolean;
  readonly hasPaidSince: boolean;
  readonly suspicionScore: number;

  readonly priorSuccessCount: number;
  readonly priorFailureCount: number;

  /** Reminders already sent for this order, and across all of this customer's orders. */
  readonly remindersSentForOrder: number;
  readonly remindersSentToCustomer: number;

  readonly merchantApprovalThresholdPaise: number;
  readonly merchantHasApproved: boolean;

  readonly failedAt: string;
  readonly expiresAt: string;
  readonly lastActionAt: string | null;

  /** Evaluation-time only: CONTROL cases are deliberately never contacted. */
  readonly arm: 'TREATMENT' | 'CONTROL';

  /** Decision time. Passed in, never read from the clock, so replays are deterministic. */
  readonly now: string;
}

export interface PolicyCheckResult {
  readonly rule: string;
  readonly passed: boolean;
  readonly reason: BlockReason | null;
  readonly detail: string;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly blockReason: BlockReason | null;
  /** Every rule that ran, in order, whether it passed or failed. */
  readonly checks: readonly PolicyCheckResult[];
}

export interface PlannedAction {
  readonly action: ActionType;
  readonly delayMinutes: number;
  readonly requiresApproval: boolean;
  readonly rationale: string;
}

export interface Decision {
  readonly caseId: string;
  readonly diagnosis: Diagnosis;
  readonly policy: PolicyDecision;
  readonly planned: PlannedAction;
  readonly explanation: string;
}
