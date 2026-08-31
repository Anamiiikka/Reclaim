/**
 * Detection: find payment attempts worth recovering, and assemble the snapshot the
 * decision layer reads.
 *
 * The snapshot query is the only place the decision path touches the database. Once
 * a CaseSnapshot exists, everything downstream is pure — which is what makes replay
 * and testing straightforward.
 */

import type { Sql } from 'postgres';

import type { CaseSnapshot, Diagnosis } from '../types.js';

/** How long a case stays eligible for recovery activity (G8). */
export const RECOVERY_WINDOW_HOURS = 72;

/**
 * A checkout is only "abandoned" once the customer has clearly gone. Any shorter
 * and we would be chasing people who are still typing their card number.
 */
export const ABANDONMENT_THRESHOLD_MINUTES = 30;

export interface DetectionCandidate {
  readonly attemptId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly failedAt: string;
}

/**
 * Recovery-eligible attempts.
 *
 * Deliberately excluded here rather than left to the policy engine:
 *   - orders that later succeeded (a second attempt on the same order paid)
 *   - attempts already attached to a case
 *
 * These are facts about the world, not policy judgments, so they belong in detection.
 * Consent, caps and fraud are policy and stay in the policy engine, where they are
 * reported in the audit trail rather than silently filtering rows out.
 */
export async function detectCandidates(sql: Sql, now: Date, limit = 10_000): Promise<DetectionCandidate[]> {
  const rows = await sql<
    Array<{
      id: string;
      order_id: string;
      customer_id: string;
      merchant_id: string;
      amount_paise: string;
      attempted_at: Date;
    }>
  >`
    SELECT pa.id, pa.order_id, pa.customer_id, pa.merchant_id, pa.amount_paise, pa.attempted_at
    FROM payment_attempts pa
    WHERE pa.status IN ('FAILED', 'ABANDONED')
      AND pa.attempted_at > ${now}::timestamptz - ${`${RECOVERY_WINDOW_HOURS} hours`}::interval
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts paid
        WHERE paid.order_id = pa.order_id AND paid.status = 'SUCCESS'
      )
      AND NOT EXISTS (
        SELECT 1 FROM recovery_cases rc WHERE rc.payment_attempt_id = pa.id
      )
    ORDER BY pa.amount_paise DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    attemptId: r.id,
    orderId: r.order_id,
    customerId: r.customer_id,
    merchantId: r.merchant_id,
    amountPaise: Number(r.amount_paise),
    failedAt: r.attempted_at.toISOString(),
  }));
}

/**
 * Assemble the decision-time snapshot for one case.
 *
 * Every field the policy engine can read is gathered here, in one query, at one
 * instant. Storing this object in the audit log is what makes a decision replayable:
 * a replay reads the stored snapshot, never the live tables.
 */
export async function buildSnapshot(
  sql: Sql,
  caseId: string,
  now: Date,
): Promise<CaseSnapshot | null> {
  const rows = await sql<
    Array<{
      case_id: string;
      customer_id: string;
      merchant_id: string;
      order_id: string;
      amount_paise: string;
      payment_method: string;
      attempt_status: string;
      failure_code: string | null;
      checkout_stage: string | null;
      diagnosis: Diagnosis | null;
      diagnosis_confidence: string | null;
      recovery_probability: string | null;
      is_opted_out: boolean;
      has_paid_since: boolean;
      prior_success_count: number;
      prior_failure_count: number;
      reminders_for_order: string;
      reminders_to_customer: string;
      approval_threshold_paise: string;
      failed_at: Date;
      expires_at: Date;
      last_action_at: Date | null;
      arm: 'TREATMENT' | 'CONTROL';
    }>
  >`
    SELECT
      rc.id                        AS case_id,
      rc.customer_id,
      rc.merchant_id,
      rc.order_id,
      rc.amount_at_risk_paise      AS amount_paise,
      pa.payment_method,
      pa.status::text              AS attempt_status,
      pa.failure_code,
      pa.checkout_stage,
      rc.diagnosis,
      rc.diagnosis_confidence,
      rc.recovery_probability,
      COALESCE(cp.is_opted_out, false) AS is_opted_out,
      EXISTS (
        SELECT 1 FROM payment_attempts paid
        WHERE paid.order_id = rc.order_id
          AND paid.status = 'SUCCESS'
          AND paid.attempted_at > pa.attempted_at
      )                            AS has_paid_since,
      c.prior_success_count,
      c.prior_failure_count,
      (SELECT count(*) FROM recovery_actions ra
        JOIN recovery_cases rc2 ON rc2.id = ra.case_id
       WHERE rc2.order_id = rc.order_id
         AND ra.status IN ('SENT', 'EXECUTING')
         AND ra.action IN ('SEND_PAYMENT_LINK', 'SUGGEST_ALTERNATE_METHOD', 'DELAYED_RETRY_PROMPT')
      )                            AS reminders_for_order,
      (SELECT count(*) FROM recovery_actions ra
       WHERE ra.customer_id = rc.customer_id
         AND ra.status IN ('SENT', 'EXECUTING')
         AND ra.action IN ('SEND_PAYMENT_LINK', 'SUGGEST_ALTERNATE_METHOD', 'DELAYED_RETRY_PROMPT')
      )                            AS reminders_to_customer,
      m.approval_threshold_paise,
      pa.attempted_at              AS failed_at,
      rc.expires_at,
      (SELECT max(ra.executed_at) FROM recovery_actions ra WHERE ra.case_id = rc.id) AS last_action_at,
      rc.arm
    FROM recovery_cases rc
    JOIN payment_attempts pa ON pa.id = rc.payment_attempt_id
    JOIN customers c         ON c.id = rc.customer_id
    JOIN merchants m         ON m.id = rc.merchant_id
    LEFT JOIN customer_preferences cp ON cp.customer_id = rc.customer_id
    WHERE rc.id = ${caseId}
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    caseId: row.case_id,
    customerId: row.customer_id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    amountPaise: Number(row.amount_paise),
    paymentMethod: row.payment_method,
    attemptStatus: row.attempt_status as CaseSnapshot['attemptStatus'],
    failureCode: row.failure_code,
    checkoutStage: row.checkout_stage,
    diagnosis: row.diagnosis ?? 'UNKNOWN',
    diagnosisConfidence: row.diagnosis_confidence === null ? 0 : Number(row.diagnosis_confidence),
    recoveryProbability: row.recovery_probability === null ? null : Number(row.recovery_probability),
    isOptedOut: row.is_opted_out,
    hasPaidSince: row.has_paid_since,
    // Populated by the risk model in a later phase; absent means no signal, not "safe".
    suspicionScore: 0,
    priorSuccessCount: row.prior_success_count,
    priorFailureCount: row.prior_failure_count,
    remindersSentForOrder: Number(row.reminders_for_order),
    remindersSentToCustomer: Number(row.reminders_to_customer),
    merchantApprovalThresholdPaise: Number(row.approval_threshold_paise),
    // Set by the approval workflow in Phase 3.
    merchantHasApproved: false,
    failedAt: row.failed_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastActionAt: row.last_action_at?.toISOString() ?? null,
    arm: row.arm,
    now: now.toISOString(),
  };
}

/** Expiry instant for a case detected from a failure at `failedAt`. */
export function recoveryExpiresAt(failedAt: Date): Date {
  return new Date(failedAt.getTime() + RECOVERY_WINDOW_HOURS * 3_600_000);
}
