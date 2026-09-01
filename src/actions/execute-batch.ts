/**
 * Batched execution of due actions.
 *
 * Same semantics as runDueActions in execute.ts — same idempotency keys, same
 * one-retry-then-escalate rule, same audit events — but shaped for throughput:
 *
 *   - payment-API calls run concurrently, since they are independent network I/O
 *   - the resulting database writes are grouped, instead of four round trips per job
 *
 * Sequentially this ran ~15 jobs/second against a hosted database, so a thousand
 * actions took over a minute of dead air. The demo runs the whole pipeline live, and
 * the panel should be watching decisions rather than a progress counter.
 *
 * The per-job version stays in execute.ts: it is the honest shape for a real worker
 * draining a queue, and it is what the unit tests exercise.
 */

import type { Sql } from 'postgres';

import { PaymentClientError } from '../payments/client.js';
import type { PaymentClient, PaymentLink } from '../payments/client.js';
import type { ActionType } from '../types.js';
import type { ExecutionSummary } from './execute.js';

const CUSTOMER_FACING: ReadonlySet<ActionType> = new Set([
  'SEND_PAYMENT_LINK',
  'SUGGEST_ALTERNATE_METHOD',
  'DELAYED_RETRY_PROMPT',
]);

/** How many payment-API calls to have in flight at once. */
const CONCURRENCY = 20;

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

type Outcome =
  | { kind: 'sent'; job: ClaimedJob; link: PaymentLink | null }
  | { kind: 'retry'; job: ClaimedJob; message: string }
  | { kind: 'escalate'; job: ClaimedJob; message: string };

/** Resolve one job's outcome. Performs the API call but writes nothing. */
async function resolveJob(job: ClaimedJob, client: PaymentClient): Promise<Outcome> {
  if (!CUSTOMER_FACING.has(job.action)) {
    // Merchant alerts and escalations have no external call to make.
    return { kind: 'sent', job, link: null };
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
    return { kind: 'sent', job, link };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = error instanceof PaymentClientError && error.retryable;
    // One retry, then a human. Retrying further would burn the recovery window and
    // risk contacting the customer if an earlier call actually succeeded.
    return retryable && job.attempt_count + 1 < 2
      ? { kind: 'retry', job, message }
      : { kind: 'escalate', job, message };
  }
}

/** Run `tasks` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runDueActionsBatched(
  sql: Sql,
  client: PaymentClient,
  now: Date,
  options: { workerId?: string; limit?: number } = {},
): Promise<ExecutionSummary> {
  const workerId = options.workerId ?? `worker_${process.pid}`;
  const jobs = await claimJobs(sql, now, workerId, options.limit ?? 500);
  if (jobs.length === 0) {
    return { claimed: 0, sent: 0, pendingRetry: 0, escalated: 0, failed: 0 };
  }

  const outcomes = await mapLimit(jobs, CONCURRENCY, (job) => resolveJob(job, client));

  const sent = outcomes.filter((o): o is Extract<Outcome, { kind: 'sent' }> => o.kind === 'sent');
  const retries = outcomes.filter((o): o is Extract<Outcome, { kind: 'retry' }> => o.kind === 'retry');
  const escalations = outcomes.filter((o): o is Extract<Outcome, { kind: 'escalate' }> => o.kind === 'escalate');

  const auditRows: Array<Record<string, unknown>> = [];

  if (sent.length > 0) {
    // Split by whether a link exists: merchant alerts and escalations make no API
    // call, so they have no link, and the VALUES helper will not carry nulls.
    const withLink = sent.filter(
      (o): o is Extract<Outcome, { kind: 'sent' }> & { link: PaymentLink } => o.link !== null,
    );
    const withoutLink = sent.filter((o) => o.link === null);

    if (withLink.length > 0) {
      await sql`
        UPDATE recovery_actions ra
        SET status = 'SENT', executed_at = ${now}, attempt_count = ra.attempt_count + 1,
            payment_link_id = v.link_id, payment_link_url = v.link_url, last_error = NULL
        FROM (VALUES ${sql(withLink.map((o) => [o.job.action_id, o.link.id, o.link.url]))})
             AS v(id, link_id, link_url)
        WHERE ra.id = v.id
      `;
    }
    if (withoutLink.length > 0) {
      await sql`
        UPDATE recovery_actions
        SET status = 'SENT', executed_at = ${now}, attempt_count = attempt_count + 1, last_error = NULL
        WHERE id IN ${sql(withoutLink.map((o) => o.job.action_id))}
      `;
    }
    await sql`
      UPDATE scheduled_actions SET completed_at = ${now}
      WHERE action_id IN ${sql(sent.map((o) => o.job.action_id))}
    `;
    for (const o of sent) {
      auditRows.push({
        case_id: o.job.case_id,
        action_id: o.job.action_id,
        event_type: 'ACTION_EXECUTED',
        explanation: o.link
          ? `${o.job.action} executed; payment link ${o.link.id} issued`
          : `${o.job.action} executed`,
        actor: `system:${client.name}`,
      });
    }
  }

  if (retries.length > 0) {
    await sql`
      UPDATE recovery_actions ra
      SET status = 'PENDING_RETRY', attempt_count = ra.attempt_count + 1, last_error = v.err
      FROM (VALUES ${sql(retries.map((o) => [o.job.action_id, o.message]))}) AS v(id, err)
      WHERE ra.id = v.id
    `;
    // Re-arm rather than complete: the same idempotency key is reused, so a link the
    // provider already created is returned rather than duplicated.
    await sql`
      UPDATE scheduled_actions
      SET locked_at = NULL, locked_by = NULL, run_after = ${new Date(now.getTime() + 5 * 60_000)}
      WHERE action_id IN ${sql(retries.map((o) => o.job.action_id))}
    `;
    for (const o of retries) {
      auditRows.push({
        case_id: o.job.case_id,
        action_id: o.job.action_id,
        event_type: 'ACTION_FAILED',
        explanation:
          `${o.job.action} failed (${o.message}); retrying once under the same idempotency key. ` +
          'No customer was contacted.',
        actor: `system:${client.name}`,
      });
    }
  }

  if (escalations.length > 0) {
    await sql`
      UPDATE recovery_actions ra
      SET status = 'FAILED', attempt_count = ra.attempt_count + 1, last_error = v.err
      FROM (VALUES ${sql(escalations.map((o) => [o.job.action_id, o.message]))}) AS v(id, err)
      WHERE ra.id = v.id
    `;
    await sql`
      UPDATE scheduled_actions SET completed_at = ${now}
      WHERE action_id IN ${sql(escalations.map((o) => o.job.action_id))}
    `;
    await sql`
      UPDATE recovery_cases SET status = 'ESCALATED'
      WHERE id IN ${sql(escalations.map((o) => o.job.case_id))}
    `;
    for (const o of escalations) {
      auditRows.push({
        case_id: o.job.case_id,
        action_id: o.job.action_id,
        event_type: 'ESCALATED',
        explanation:
          `${o.job.action} could not be completed automatically (${o.message}). ` +
          'Escalated to the merchant queue. No customer was contacted.',
        actor: `system:${client.name}`,
      });
    }
  }

  if (auditRows.length > 0) {
    for (let i = 0; i < auditRows.length; i += 500) {
      await sql`INSERT INTO audit_events ${sql(auditRows.slice(i, i + 500))}`;
    }
  }

  return {
    claimed: jobs.length,
    sent: sent.length,
    pendingRetry: retries.length,
    escalated: escalations.length,
    failed: escalations.length,
  };
}
