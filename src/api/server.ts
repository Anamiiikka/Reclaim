/**
 * Dashboard API.
 *
 * Read-only. The dashboard shows what the pipeline decided; it cannot change a
 * decision, because a decision that could be edited after the fact would make the
 * audit trail worthless.
 *
 *   npx tsx src/api/server.ts
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';
import type { Sql } from 'postgres';

const PORT = Number(process.env['PORT'] ?? 3000);

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

const sql: Sql = postgres(loadDatabaseUrl(), { ssl: 'require', max: 10 });

/** Overview counts, in one round trip. */
async function overview() {
  const [totals] = await sql<Array<Record<string, string>>>`
    SELECT
      count(*)::text                                                        AS cases,
      count(*) FILTER (WHERE status = 'SUPPRESSED')::text                   AS suppressed,
      count(*) FILTER (WHERE status = 'ESCALATED')::text                    AS escalated,
      count(*) FILTER (WHERE arm = 'CONTROL')::text                         AS control_arm,
      sum(amount_at_risk_paise)::text                                       AS at_risk_paise
    FROM recovery_cases
  `;

  const [actions] = await sql<Array<Record<string, string>>>`
    SELECT
      count(*)::text                                                        AS actions,
      count(*) FILTER (WHERE status = 'SENT')::text                         AS sent,
      count(*) FILTER (WHERE status = 'FAILED')::text                       AS failed,
      count(*) FILTER (WHERE payment_link_id IS NOT NULL)::text             AS links,
      count(*) FILTER (WHERE payment_link_id NOT LIKE 'plink_sim_%'
                         AND payment_link_id IS NOT NULL)::text             AS real_links
    FROM recovery_actions
  `;

  const byDiagnosis = await sql<Array<{ diagnosis: string; n: string; at_risk: string }>>`
    SELECT diagnosis::text AS diagnosis, count(*)::text AS n,
           sum(amount_at_risk_paise)::text AS at_risk
    FROM recovery_cases WHERE diagnosis IS NOT NULL
    GROUP BY diagnosis ORDER BY count(*) DESC
  `;

  const byAction = await sql<Array<{ action: string; n: string }>>`
    SELECT ae.decision_output->'planned'->>'action' AS action, count(*)::text AS n
    FROM audit_events ae WHERE ae.event_type = 'DECISION_MADE'
    GROUP BY 1 ORDER BY count(*) DESC
  `;

  const blocks = await sql<Array<{ reason: string; n: string }>>`
    SELECT ae.decision_output->'policy'->>'blockReason' AS reason, count(*)::text AS n
    FROM audit_events ae
    WHERE ae.event_type = 'DECISION_MADE'
      AND ae.decision_output->'policy'->>'blockReason' IS NOT NULL
    GROUP BY 1 ORDER BY count(*) DESC
  `;

  return { totals, actions, byDiagnosis, byAction, blocks };
}

/** One page of the case queue. */
async function cases(params: URLSearchParams) {
  const limit = Math.min(Number(params.get('limit') ?? 50), 200);
  const offset = Math.max(Number(params.get('offset') ?? 0), 0);
  const status = params.get('status');
  const diagnosis = params.get('diagnosis');

  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT rc.id, rc.status::text AS status, rc.diagnosis::text AS diagnosis,
           rc.arm::text AS arm, rc.amount_at_risk_paise::text AS amount_paise,
           rc.diagnosis_confidence::text AS confidence,
           rc.recovery_probability::text AS recovery_probability,
           rc.detected_at,
           ae.decision_output->'planned'->>'action' AS action,
           (ae.decision_output->'planned'->>'requiresApproval')::boolean AS requires_approval,
           ra.status::text AS action_status,
           ra.payment_link_url
    FROM recovery_cases rc
    LEFT JOIN LATERAL (
      SELECT decision_output FROM audit_events
      WHERE case_id = rc.id AND event_type = 'DECISION_MADE' ORDER BY id DESC LIMIT 1
    ) ae ON true
    LEFT JOIN recovery_actions ra ON ra.case_id = rc.id
    WHERE (${status}::text IS NULL OR rc.status::text = ${status})
      AND (${diagnosis}::text IS NULL OR rc.diagnosis::text = ${diagnosis})
    ORDER BY rc.amount_at_risk_paise DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const counted = await sql<Array<{ total: string }>>`
    SELECT count(*)::text AS total FROM recovery_cases rc
    WHERE (${status}::text IS NULL OR rc.status::text = ${status})
      AND (${diagnosis}::text IS NULL OR rc.diagnosis::text = ${diagnosis})
  `;

  return { rows, total: Number(counted[0]?.total ?? 0), limit, offset };
}

/** Everything about one case: its decision, its policy checks, its timeline. */
async function caseDetail(caseId: string) {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT rc.*, pa.failure_code, pa.failure_message, pa.payment_method,
           pa.attempted_at, pa.attempt_number, pa.checkout_stage,
           c.city, c.prior_success_count, c.prior_failure_count,
           COALESCE(cp.is_opted_out, false) AS is_opted_out,
           m.name AS merchant_name, m.approval_threshold_paise::text AS approval_threshold_paise
    FROM recovery_cases rc
    JOIN payment_attempts pa ON pa.id = rc.payment_attempt_id
    JOIN customers c ON c.id = rc.customer_id
    JOIN merchants m ON m.id = rc.merchant_id
    LEFT JOIN customer_preferences cp ON cp.customer_id = rc.customer_id
    WHERE rc.id = ${caseId}
  `;
  if (!row) return null;

  const timeline = await sql<Array<Record<string, unknown>>>`
    SELECT id, event_type, occurred_at, explanation, actor,
           decision_output->'policy'->'checks' AS policy_checks,
           decision_output->'planned' AS planned
    FROM audit_events WHERE case_id = ${caseId} ORDER BY id
  `;

  const actions = await sql<Array<Record<string, unknown>>>`
    SELECT id, action::text AS action, status::text AS status, attempt_count,
           idempotency_key, payment_link_id, payment_link_url,
           scheduled_for, executed_at, last_error
    FROM recovery_actions WHERE case_id = ${caseId} ORDER BY id
  `;

  return { case: row, timeline, actions };
}

/** The evaluation report, straight from disk. */
function evaluationReport(): unknown {
  const path = resolve(process.cwd(), 'evaluation', 'report.json');
  if (!existsSync(path)) return { error: 'run npm run eval first' };
  return JSON.parse(readFileSync(path, 'utf8'));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Type', 'application/json');

  const send = (status: number, body: unknown): void => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };

  void (async () => {
    try {
      if (url.pathname === '/api/overview') return send(200, await overview());
      if (url.pathname === '/api/cases') return send(200, await cases(url.searchParams));
      if (url.pathname === '/api/evaluation') return send(200, evaluationReport());

      const detail = /^\/api\/cases\/([\w-]+)$/.exec(url.pathname);
      if (detail?.[1]) {
        const found = await caseDetail(detail[1]);
        return found ? send(200, found) : send(404, { error: 'no such case' });
      }

      send(404, { error: 'not found' });
    } catch (error) {
      console.error(error);
      send(500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`Reclaim API on http://localhost:${PORT}`);
  console.log('  /api/overview  /api/cases  /api/cases/:id  /api/evaluation');
});
