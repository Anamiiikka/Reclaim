/**
 * Action execution and the durable job queue.
 *
 * The property this file exists to guarantee: **a payment-API failure never results
 * in a customer being contacted twice.** Everything else here serves that.
 *
 * How it is achieved:
 *   - The idempotency key is derived from case + action + sequence, not random, so a
 *     replayed event produces the same key.
 *   - recovery_actions.idempotency_key is UNIQUE, so the database refuses a duplicate
 *     even if two workers race. The constraint is the enforcement; application checks
 *     are only an optimisation.
 *   - A failed call is retried at most once (attempt_count <= 2, also a DB constraint),
 *     and only when the error is retryable. Then it escalates to the merchant.
 *   - Rows are claimed with FOR UPDATE SKIP LOCKED, so two workers never take the
 *     same job.
 */

import { createHash } from 'node:crypto';

import type { Sql } from 'postgres';

import { PaymentClientError } from '../payments/client.js';
import type { PaymentClient } from '../payments/client.js';
import { writeAudit } from '../decisions/audit.js';
import type { ActionType } from '../types.js';

/** Actions that put a message in front of a customer. */
const CUSTOMER_FACING: ReadonlySet<ActionType> = new Set([
  'SEND_PAYMENT_LINK',
  'SUGGEST_ALTERNATE_METHOD',
  'DELAYED_RETRY_PROMPT',
]);

/**
 * Derive a stable idempotency key.
 *
 * Deterministic on purpose: re-running detection after a crash must produce the same
 * key for the same logical action, so the unique constraint recognises it as a repeat
 * rather than letting a second link through.
 */
export function idempotencyKeyFor(caseId: string, action: ActionType, sequence: number): string {
  const digest = createHash('sha256').update(`${caseId}|${action}|${sequence}`).digest('hex');
  return `idem_${digest.slice(0, 32)}`;
}

export interface ScheduleRequest {
  readonly caseId: string;
  readonly customerId: string;
  readonly action: ActionType;
  readonly runAfter: Date;
  readonly sequence?: number;
}

/**
 * Schedule an action.
 *
 * Returns the action id, or null when this action already exists — which is the
 * normal, expected outcome of a replayed event, not an error.
 */
export async function scheduleAction(sql: Sql, request: ScheduleRequest): Promise<string | null> {
  const sequence = request.sequence ?? 1;
  const key = idempotencyKeyFor(request.caseId, request.action, sequence);
  const actionId = `act_${key.slice(5, 21)}`;

  const inserted = await sql<Array<{ id: string }>>`
    INSERT INTO recovery_actions (id, case_id, customer_id, action, status, idempotency_key, scheduled_for)
    VALUES (${actionId}, ${request.caseId}, ${request.customerId}, ${request.action},
            'SCHEDULED', ${key}, ${request.runAfter})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;

  const row = inserted[0];
  if (!row) return null;

  await sql`
    INSERT INTO scheduled_actions (action_id, run_after)
    VALUES (${actionId}, ${request.runAfter})
    ON CONFLICT (action_id) DO NOTHING
  `;

  await writeAudit(sql, {
    caseId: request.caseId,
    actionId,
    eventType: 'ACTION_SCHEDULED',
    decisionInput: null,
    decisionOutput: null,
    explanation: `${request.action} scheduled for ${request.runAfter.toISOString()}`,
    actor: 'system',
  });

  return actionId;
}

interface ClaimedJob {
  job_id: string;
  action_id: string;
  case_id: string;
  customer_id: string;
  action: ActionType;
  attempt_count: number;
  idempotency_key: string;
  amount_paise: string;
  order_id: string;
}

/**
 * Claim runnable jobs.
 *
 * SKIP LOCKED is what makes multiple workers safe: a row held by one worker is
 * invisible to another rather than blocking it. The five-minute lock expiry lets a
 * job recover if a worker dies mid-flight.
 */
async function claimJobs(sql: Sql, now: Date, workerId: string, limit: number): Promise<ClaimedJob[]> {
  return sql<ClaimedJob[]>`
    WITH claimed AS (
      SELECT sa.id
      FROM scheduled_actions sa
      WHERE sa.completed_at IS NULL
        AND sa.run_after <= ${now}
        -- Lock expiry uses wall-clock now(), not the simulated decision time. A lock
        -- records that a worker is alive and holding this row, which is a real-world
        -- fact; comparing it against simulated time made rows from a killed run
        -- unreclaimable whenever the simulation clock moved backwards.
        AND (sa.locked_at IS NULL OR sa.locked_at < now() - interval '5 minutes')
      ORDER BY sa.run_after
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE scheduled_actions sa
    SET locked_at = ${now}, locked_by = ${workerId}
    FROM claimed c, recovery_actions ra, recovery_cases rc
    WHERE sa.id = c.id AND ra.id = sa.action_id AND rc.id = ra.case_id
    RETURNING sa.id AS job_id, ra.id AS action_id, ra.case_id, ra.customer_id,
              ra.action, ra.attempt_count, ra.idempotency_key,
              rc.amount_at_risk_paise AS amount_paise, rc.order_id
  `;
}

export interface ExecutionSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly pendingRetry: number;
  /** Rate-limited: requeued without consuming a retry. Not a failure. */
  readonly deferred?: number;
  readonly escalated: number;
  readonly failed: number;
}

/**
 * Execute one batch of due actions.
 *
 * Each job is handled independently: one failure must not abort the batch, because a
 * transient provider problem on one case says nothing about the others.
 */
export async function runDueActions(
  sql: Sql,
  client: PaymentClient,
  now: Date,
  options: { workerId?: string; limit?: number } = {},
): Promise<ExecutionSummary> {
  const workerId = options.workerId ?? `worker_${process.pid}`;
  const jobs = await claimJobs(sql, now, workerId, options.limit ?? 100);

  let sent = 0;
  let pendingRetry = 0;
  let escalated = 0;
  let failed = 0;

  for (const job of jobs) {
    if (!CUSTOMER_FACING.has(job.action)) {
      // Merchant alerts and escalations have no external call to make.
      await sql`UPDATE recovery_actions SET status = 'SENT', executed_at = ${now} WHERE id = ${job.action_id}`;
      await sql`UPDATE scheduled_actions SET completed_at = ${now} WHERE id = ${job.job_id}`;
      sent += 1;
      continue;
    }

    try {
      const link = await client.createPaymentLink({
        caseId: job.case_id,
        orderId: job.order_id,
        customerId: job.customer_id,
        amountPaise: Number(job.amount_paise),
        description: `Complete your payment (case ${job.case_id})`,
        idempotencyKey: job.idempotency_key,
      });

      await sql`
        UPDATE recovery_actions
        SET status = 'SENT', executed_at = ${now}, attempt_count = attempt_count + 1,
            payment_link_id = ${link.id}, payment_link_url = ${link.url}, last_error = NULL
        WHERE id = ${job.action_id}
      `;
      await sql`UPDATE scheduled_actions SET completed_at = ${now} WHERE id = ${job.job_id}`;
      await writeAudit(sql, {
        caseId: job.case_id,
        actionId: job.action_id,
        eventType: 'ACTION_EXECUTED',
        decisionInput: null,
        decisionOutput: null,
        explanation: `${job.action} executed; payment link ${link.id} issued`,
        actor: `system:${client.name}`,
      });
      sent += 1;
    } catch (error) {
      const isPaymentError = error instanceof PaymentClientError;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = isPaymentError && error.retryable;
      const nextAttempt = job.attempt_count + 1;

      // One retry, then a human. Retrying further would burn the recovery window and
      // risk contacting the customer if an earlier call actually succeeded.
      const willRetry = retryable && nextAttempt < 2;

      if (willRetry) {
        await sql`
          UPDATE recovery_actions
          SET status = 'PENDING_RETRY', attempt_count = ${nextAttempt}, last_error = ${message}
          WHERE id = ${job.action_id}
        `;
        // Re-arm the job rather than completing it. The same idempotency key is reused,
        // so a link the provider already created is returned, not duplicated.
        await sql`
          UPDATE scheduled_actions
          SET locked_at = NULL, locked_by = NULL,
              run_after = ${new Date(now.getTime() + 5 * 60_000)}
          WHERE id = ${job.job_id}
        `;
        await writeAudit(sql, {
          caseId: job.case_id,
          actionId: job.action_id,
          eventType: 'ACTION_FAILED',
          decisionInput: null,
          decisionOutput: null,
          explanation:
            `${job.action} failed (${message}); retrying once under the same idempotency key. ` +
            'No customer was contacted.',
          actor: `system:${client.name}`,
        });
        pendingRetry += 1;
      } else {
        await sql`
          UPDATE recovery_actions
          SET status = 'FAILED', attempt_count = ${nextAttempt}, last_error = ${message}
          WHERE id = ${job.action_id}
        `;
        await sql`UPDATE scheduled_actions SET completed_at = ${now} WHERE id = ${job.job_id}`;
        await sql`UPDATE recovery_cases SET status = 'ESCALATED' WHERE id = ${job.case_id}`;
        await writeAudit(sql, {
          caseId: job.case_id,
          actionId: job.action_id,
          eventType: 'ESCALATED',
          decisionInput: null,
          decisionOutput: null,
          explanation:
            `${job.action} could not be completed automatically (${message}). ` +
            'Escalated to the merchant queue. No customer was contacted.',
          actor: `system:${client.name}`,
        });
        escalated += 1;
        failed += 1;
      }
    }
  }

  return { claimed: jobs.length, sent, pendingRetry, escalated, failed };
}

/**
 * Schedule many actions in a few round trips.
 *
 * Same semantics as scheduleAction — same derived keys, same ON CONFLICT DO NOTHING —
 * but three queries per batch instead of three per case. Scheduling ~1,000 actions one
 * at a time against a hosted database took minutes; this takes seconds, which matters
 * because the demo runs the whole pipeline live.
 *
 * Returns the ids actually inserted; keys that already existed are skipped, which is
 * the normal outcome of a replay rather than an error.
 */
export async function scheduleActionsBatch(
  sql: Sql,
  requests: readonly ScheduleRequest[],
  batchSize = 500,
): Promise<string[]> {
  const inserted: string[] = [];

  for (let offset = 0; offset < requests.length; offset += batchSize) {
    const chunk = requests.slice(offset, offset + batchSize);

    const actionRows = chunk.map((request) => {
      const key = idempotencyKeyFor(request.caseId, request.action, request.sequence ?? 1);
      return {
        id: `act_${key.slice(5, 21)}`,
        case_id: request.caseId,
        customer_id: request.customerId,
        action: request.action,
        status: 'SCHEDULED' as const,
        idempotency_key: key,
        scheduled_for: request.runAfter,
      };
    });

    const created = await sql<Array<{ id: string }>>`
      INSERT INTO recovery_actions ${sql(actionRows)}
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (created.length === 0) continue;

    const createdIds = new Set(created.map((row) => row.id));
    const jobRows = actionRows
      .filter((row) => createdIds.has(row.id))
      .map((row) => ({ action_id: row.id, run_after: row.scheduled_for }));

    await sql`INSERT INTO scheduled_actions ${sql(jobRows)} ON CONFLICT (action_id) DO NOTHING`;

    const auditRows = actionRows
      .filter((row) => createdIds.has(row.id))
      .map((row) => ({
        case_id: row.case_id,
        action_id: row.id,
        event_type: 'ACTION_SCHEDULED',
        explanation: `${row.action} scheduled for ${row.scheduled_for.toISOString()}`,
        actor: 'system',
      }));
    await sql`INSERT INTO audit_events ${sql(auditRows)}`;

    inserted.push(...createdIds);
  }

  return inserted;
}
