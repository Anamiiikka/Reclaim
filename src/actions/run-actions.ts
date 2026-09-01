/**
 * Schedule decided cases, then execute what is due.
 *
 *   npx tsx src/actions/run-actions.ts            # schedule + execute
 *   npx tsx src/actions/run-actions.ts --fail-demo # inject API failures
 *
 * The --fail-demo flag scripts payment-API failures on a handful of cases so the
 * recorded demo can show PENDING_RETRY, one retry under the same idempotency key,
 * then escalation — with no duplicate customer contact. A real API will not fail on
 * cue, which is precisely why the simulator exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

import { scheduleActionsBatch } from './execute.js';
import { runDueActionsBatched } from './execute-batch.js';
import { createPaymentClient, SimulatedPaymentClient } from '../payments/index.js';
import type { FailureMode } from '../payments/simulated.js';
import type { PaymentClient } from '../payments/client.js';
import type { ActionType } from '../types.js';

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

/** Load .env into process.env so PAYMENT_CLIENT and keys are picked up. */
function loadEnv(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
  }
}

interface DecidedCase {
  id: string;
  customer_id: string;
  action: ActionType;
  delay_minutes: string;
  detected_at: Date;
}

/**
 * Cap on how many real payment links a single run will create.
 *
 * Razorpay's test mode is not built for bulk: creating ~1,000 links exhausted the
 * account's quota and returned 429 on 80% of calls. That is a property of the
 * sandbox, not of Reclaim, so the pipeline proves the integration on a sample and
 * runs the rest through the simulator. Every link created here is real and openable.
 */
const RAZORPAY_LINK_BUDGET = 25;

async function main(): Promise<void> {
  loadEnv();
  const failDemo = process.argv.includes('--fail-demo');
  const sql = postgres(loadDatabaseUrl(), { ssl: 'require', max: 10 });

  try {
    // Every case whose decision planned a real action, with the delay the planner chose.
    const decided = await sql<DecidedCase[]>`
      SELECT rc.id, rc.customer_id,
             (ae.decision_output->'planned'->>'action')::text AS action,
             (ae.decision_output->'planned'->>'delayMinutes')::text AS delay_minutes,
             rc.detected_at
      FROM recovery_cases rc
      JOIN LATERAL (
        SELECT decision_output FROM audit_events
        WHERE case_id = rc.id AND event_type = 'DECISION_MADE'
        ORDER BY id DESC LIMIT 1
      ) ae ON true
      WHERE rc.status IN ('DECIDED', 'ESCALATED')
        AND (ae.decision_output->'planned'->>'action') <> 'NO_ACTION'
        AND (ae.decision_output->'planned'->>'requiresApproval')::boolean = false
        AND NOT EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.case_id = rc.id)
      ORDER BY rc.id
    `;

    console.log(`${decided.length} decided cases need an action scheduled`);

    const created = await scheduleActionsBatch(
      sql,
      decided.map((row) => ({
        caseId: row.id,
        customerId: row.customer_id,
        action: row.action,
        runAfter: new Date(row.detected_at.getTime() + Number(row.delay_minutes) * 60_000),
      })),
    );
    console.log(`scheduled ${created.length} actions (${decided.length - created.length} already existed)`);

    // Execute as of a time past every scheduled delay, so the demo does not wait hours.
    const now = new Date('2026-09-05T00:00:00.000Z');

    let client: PaymentClient;
    if (failDemo) {
      // Script failures onto the first few due actions.
      const due = await sql<Array<{ idempotency_key: string; action: ActionType; case_id: string }>>`
        SELECT ra.idempotency_key, ra.action, ra.case_id
        FROM scheduled_actions sa JOIN recovery_actions ra ON ra.id = sa.action_id
        WHERE sa.completed_at IS NULL AND sa.run_after <= ${now}
          AND ra.action IN ('SEND_PAYMENT_LINK','SUGGEST_ALTERNATE_METHOD','DELAYED_RETRY_PROMPT')
        ORDER BY sa.run_after LIMIT 3
      `;
      const failures = new Map<string, FailureMode>();
      for (const [index, row] of due.entries()) {
        // One permanent failure (escalates immediately) and the rest transient
        // (retry once under the same key), so the demo shows both paths.
        failures.set(
          row.idempotency_key,
          index === 0 ? { kind: 'validation', detail: 'simulated permanent failure' } : { kind: 'timeout' },
        );
        console.log(`  scripted failure on ${row.case_id} (${row.action})`);
      }
      client = new SimulatedPaymentClient({ failures });
    } else {
      client = createPaymentClient();
    }

    // Against the real API, cap the run so the sandbox quota is not exhausted.
    if (client.name === 'razorpay') {
      const capped = await sql<Array<{ action_id: string }>>`
        SELECT sa.action_id
        FROM scheduled_actions sa JOIN recovery_actions ra ON ra.id = sa.action_id
        WHERE sa.completed_at IS NULL
          AND ra.action IN ('SEND_PAYMENT_LINK','SUGGEST_ALTERNATE_METHOD','DELAYED_RETRY_PROMPT')
        ORDER BY sa.run_after
        OFFSET ${RAZORPAY_LINK_BUDGET}
      `;
      if (capped.length > 0) {
        // Push the excess beyond this run's horizon rather than deleting it: the
        // cases stay live and a later run (or the simulator) can pick them up.
        await sql`
          UPDATE scheduled_actions SET run_after = ${new Date('2027-01-01T00:00:00.000Z')}
          WHERE action_id IN ${sql(capped.map((row) => row.action_id))}
        `;
        console.log(
          `capping at ${RAZORPAY_LINK_BUDGET} real payment links ` +
            `(${capped.length} deferred; Razorpay test mode is rate limited)`,
        );
      }
    }

    console.log(`\nexecuting due actions with the ${client.name} client`);
    if (!(await client.healthCheck())) {
      throw new Error(`${client.name} client failed its health check; aborting before contacting anyone`);
    }

    let total = { claimed: 0, sent: 0, pendingRetry: 0, escalated: 0, failed: 0 };
    // Loop until the queue drains; a batch may re-arm retries for a later pass.
    for (let pass = 0; pass < 20; pass++) {
      const summary = await runDueActionsBatched(sql, client, now, { limit: 500 });
      if (summary.claimed === 0) break;
      total = {
        claimed: total.claimed + summary.claimed,
        sent: total.sent + summary.sent,
        pendingRetry: total.pendingRetry + summary.pendingRetry,
        escalated: total.escalated + summary.escalated,
        failed: total.failed + summary.failed,
      };
      // Retries are re-armed five minutes out; advance past that on the next pass.
      now.setTime(now.getTime() + 6 * 60_000);
    }

    console.log(`\n  claimed        ${total.claimed}`);
    console.log(`  sent           ${total.sent}`);
    console.log(`  pending retry  ${total.pendingRetry}`);
    console.log(`  escalated      ${total.escalated}`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
