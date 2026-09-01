/**
 * Run detection and diagnosis across the whole dataset.
 *
 * Creates a recovery_case per eligible attempt, diagnoses it, assigns an experiment
 * arm, decides, and writes each decision with its inputs to the audit log.
 *
 *   npx tsx src/decisions/run-detection.ts [--reset]
 *
 * Batched by design. A per-case round trip to a hosted database ran ~55 cases/minute,
 * which would make a full pass a half-hour affair and unusable in a live demo. Reading
 * everything in a handful of queries, deciding in memory, and bulk-writing keeps a
 * full 1,500-case pass to a few seconds — and the decision layer is pure, so nothing
 * about correctness depends on the I/O shape.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';
import type { Sql } from 'postgres';

import { recoveryExpiresAt } from './detect.js';
import { decide } from './plan.js';
import { diagnose } from './diagnose.js';
import { scoreRecoveryProbability } from './score.js';
import { evaluatePolicy } from '../policy/rules.js';
import type { CaseSnapshot } from '../types.js';

/** Fraction of eligible cases withheld from contact to measure uplift. */
const CONTROL_ARM_FRACTION = 0.1;

/**
 * How long after a failure detection runs.
 *
 * Each case is decided relative to its own failure, not at one global instant.
 * Detection in production runs continuously, so a payment that failed on the 10th
 * was assessed on the 10th — not judged weeks later against a 72-hour window it
 * could not possibly still be inside. Using a single fixed "now" put 81% of cases
 * outside their window and left almost nothing for the evaluation to measure.
 */
const DETECTION_LAG_MINUTES = 15;

function decisionTimeFor(failedAt: Date): Date {
  return new Date(failedAt.getTime() + DETECTION_LAG_MINUTES * 60_000);
}

const INSERT_BATCH = 500;

/**
 * Assign an arm by hashing the case id.
 *
 * Deterministic on purpose: re-running detection must not reshuffle the control
 * group, or the comparison drifts every run. A random draw here would quietly
 * invalidate the experiment.
 */
function assignArm(caseId: string): 'TREATMENT' | 'CONTROL' {
  const digest = createHash('sha256').update(caseId).digest();
  return digest.readUInt32BE(0) / 0xffff_ffff < CONTROL_ARM_FRACTION ? 'CONTROL' : 'TREATMENT';
}

function loadDatabaseUrl(): string {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv) return fromEnv;

  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
    }
  }
  throw new Error('DATABASE_URL is not set');
}

interface CandidateRow {
  id: string;
  order_id: string;
  customer_id: string;
  merchant_id: string;
  amount_paise: string;
  payment_method: string;
  status: string;
  failure_code: string | null;
  checkout_stage: string | null;
  attempt_number: number;
  attempted_at: Date;
  split: string;
  is_opted_out: boolean;
  prior_success_count: number;
  prior_failure_count: number;
  approval_threshold_paise: string;
}

/**
 * Everything needed to decide every case, in one query.
 *
 * Reminder counts are omitted deliberately: this is a cold run against a fresh
 * dataset where no actions exist yet, so they are zero by construction. Phase 3
 * recomputes them from recovery_actions when actions start accumulating.
 */
async function fetchCandidates(sql: Sql): Promise<CandidateRow[]> {
  return sql<CandidateRow[]>`
    SELECT
      pa.id, pa.order_id, pa.customer_id, pa.merchant_id, pa.amount_paise,
      pa.payment_method, pa.status::text AS status, pa.failure_code,
      pa.checkout_stage, pa.attempt_number, pa.attempted_at, pa.split::text AS split,
      COALESCE(cp.is_opted_out, false) AS is_opted_out,
      c.prior_success_count, c.prior_failure_count,
      m.approval_threshold_paise
    FROM payment_attempts pa
    JOIN customers c ON c.id = pa.customer_id
    JOIN merchants m ON m.id = pa.merchant_id
    LEFT JOIN customer_preferences cp ON cp.customer_id = pa.customer_id
    WHERE pa.status IN ('FAILED', 'ABANDONED')
      AND NOT EXISTS (
        SELECT 1 FROM payment_attempts paid
        WHERE paid.order_id = pa.order_id AND paid.status = 'SUCCESS'
      )
      AND NOT EXISTS (
        SELECT 1 FROM recovery_cases rc WHERE rc.payment_attempt_id = pa.id
      )
    ORDER BY pa.id
  `;
}

function toSnapshot(row: CandidateRow, caseId: string, diagnosisResult: ReturnType<typeof diagnose>): CaseSnapshot {
  const failedAt = new Date(row.attempted_at);
  const now = decisionTimeFor(failedAt);
  return {
    caseId,
    customerId: row.customer_id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    amountPaise: Number(row.amount_paise),
    paymentMethod: row.payment_method,
    attemptStatus: row.status as CaseSnapshot['attemptStatus'],
    failureCode: row.failure_code,
    checkoutStage: row.checkout_stage,
    diagnosis: diagnosisResult.diagnosis,
    diagnosisConfidence: diagnosisResult.confidence,
    // Scored here so the planner's probability floor has something to compare
    // against. The score informs WHICH action to take; it never decides whether
    // contact is permitted -- that is the policy engine's alone.
    recoveryProbability: scoreRecoveryProbability({
      amountPaise: Number(row.amount_paise),
      priorSuccessCount: row.prior_success_count,
      priorFailureCount: row.prior_failure_count,
      diagnosis: diagnosisResult.diagnosis,
      attemptNumber: row.attempt_number,
      paymentMethod: row.payment_method,
    }),
    isOptedOut: row.is_opted_out,
    hasPaidSince: false,
    suspicionScore: 0,
    priorSuccessCount: row.prior_success_count,
    priorFailureCount: row.prior_failure_count,
    remindersSentForOrder: 0,
    remindersSentToCustomer: 0,
    merchantApprovalThresholdPaise: Number(row.approval_threshold_paise),
    merchantHasApproved: false,
    failedAt: failedAt.toISOString(),
    expiresAt: recoveryExpiresAt(failedAt).toISOString(),
    lastActionAt: null,
    arm: assignArm(caseId),
    now: now.toISOString(),
  };
}

async function main(): Promise<void> {
  const sql = postgres(loadDatabaseUrl(), { ssl: 'require', max: 10 });
  const started = Date.now();

  try {
    if (process.argv.includes('--reset')) {
      await sql`TRUNCATE audit_events, action_outcomes, scheduled_actions, recovery_actions, recovery_cases CASCADE`;
      console.log('cleared previous run');
    }

    const candidates = await fetchCandidates(sql);
    console.log(`detected ${candidates.length} recovery-eligible attempts`);

    const cases: Array<Record<string, unknown>> = [];
    const audits: Array<Record<string, unknown>> = [];
    const tally = new Map<string, number>();
    const blocks = new Map<string, number>();

    for (const row of candidates) {
      const caseId = `rcv_${row.id.replace(/^pay_/, '')}`;
      const diagnosisResult = diagnose({
        failureCode: row.failure_code,
        attemptStatus: row.status as CaseSnapshot['attemptStatus'],
        checkoutStage: row.checkout_stage,
        attemptNumber: row.attempt_number,
        suspicionScore: 0,
      });

      const snapshot = toSnapshot(row, caseId, diagnosisResult);
      const policy = evaluatePolicy(snapshot);
      const decision = decide(snapshot, policy);

      const status =
        decision.planned.action === 'NO_ACTION'
          ? 'SUPPRESSED'
          : decision.planned.action === 'HUMAN_ESCALATION'
            ? 'ESCALATED'
            : 'DECIDED';

      cases.push({
        id: caseId,
        payment_attempt_id: row.id,
        order_id: row.order_id,
        customer_id: row.customer_id,
        merchant_id: row.merchant_id,
        amount_at_risk_paise: Number(row.amount_paise),
        status,
        diagnosis: diagnosisResult.diagnosis,
        diagnosis_confidence: diagnosisResult.confidence,
        recovery_probability: snapshot.recoveryProbability,
        arm: snapshot.arm,
        split: row.split,
        detected_at: decisionTimeFor(new Date(row.attempted_at)),
        expires_at: new Date(snapshot.expiresAt),
      });

      audits.push({
        case_id: caseId,
        action_id: null,
        event_type: 'DECISION_MADE',
        // The driver serialises objects to JSONB. Calling JSON.stringify here
        // stores a JSON *string* containing escaped JSON instead, which looks fine
        // in the column but makes every -> and ->> query return null.
        decision_input: sql.json(snapshot as never),
        decision_output: sql.json(decision as never),
        policy_checks: sql.json(policy.checks as never),
        explanation: decision.explanation,
        actor: 'system',
      });

      tally.set(decision.planned.action, (tally.get(decision.planned.action) ?? 0) + 1);
      if (policy.blockReason) {
        blocks.set(policy.blockReason, (blocks.get(policy.blockReason) ?? 0) + 1);
      }
    }

    // Cases must land before audit rows: audit_events.case_id references them.
    for (let i = 0; i < cases.length; i += INSERT_BATCH) {
      await sql`INSERT INTO recovery_cases ${sql(cases.slice(i, i + INSERT_BATCH))}`;
    }
    for (let i = 0; i < audits.length; i += INSERT_BATCH) {
      await sql`INSERT INTO audit_events ${sql(audits.slice(i, i + INSERT_BATCH))}`;
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\ncreated ${cases.length} cases and ${audits.length} audit records in ${elapsed}s\n`);

    console.log('planned actions:');
    for (const [action, count] of [...tally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${action.padEnd(26)} ${String(count).padStart(5)}`);
    }

    if (blocks.size > 0) {
      console.log('\npolicy blocks:');
      for (const [reason, count] of [...blocks].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason.padEnd(34)} ${String(count).padStart(5)}`);
      }
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
