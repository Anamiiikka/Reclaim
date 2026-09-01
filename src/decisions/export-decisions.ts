/**
 * Export decisions to CSV for the Python evaluation harness.
 *
 *   npx tsx src/decisions/export-decisions.ts
 *
 * Exports what the decision layer actually decided — read from the audit log, not
 * recomputed. The evaluation must describe the decisions that were made, not ones a
 * second run might make.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

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

interface DecisionRow {
  attempt_id: string;
  case_id: string;
  arm: string;
  diagnosis: string;
  diagnosis_confidence: string;
  action: string;
  requires_approval: boolean;
  delay_minutes: string;
  block_reason: string | null;
  approval_threshold_paise: string;
}

async function main(): Promise<void> {
  const sql = postgres(loadDatabaseUrl(), { ssl: 'require', max: 5 });
  const out = resolve(process.cwd(), 'data', 'generated', 'decisions.csv');

  try {
    const rows = await sql<DecisionRow[]>`
      SELECT
        rc.payment_attempt_id                                   AS attempt_id,
        rc.id                                                   AS case_id,
        rc.arm::text                                            AS arm,
        rc.diagnosis::text                                      AS diagnosis,
        rc.diagnosis_confidence::text                           AS diagnosis_confidence,
        ae.decision_output->'planned'->>'action'                AS action,
        (ae.decision_output->'planned'->>'requiresApproval')::boolean AS requires_approval,
        ae.decision_output->'planned'->>'delayMinutes'          AS delay_minutes,
        ae.decision_output->'policy'->>'blockReason'            AS block_reason,
        m.approval_threshold_paise::text                        AS approval_threshold_paise
      FROM recovery_cases rc
      JOIN merchants m ON m.id = rc.merchant_id
      JOIN LATERAL (
        SELECT decision_output FROM audit_events
        WHERE case_id = rc.id AND event_type = 'DECISION_MADE'
        ORDER BY id DESC LIMIT 1
      ) ae ON true
      ORDER BY rc.payment_attempt_id
    `;

    const header = [
      'attempt_id', 'case_id', 'arm', 'diagnosis', 'diagnosis_confidence',
      'action', 'requires_approval', 'delay_minutes', 'block_reason',
      'approval_threshold_paise',
    ];

    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        row.attempt_id,
        row.case_id,
        row.arm,
        row.diagnosis,
        row.diagnosis_confidence,
        row.action,
        row.requires_approval ? 'True' : 'False',
        row.delay_minutes,
        row.block_reason ?? '',
        row.approval_threshold_paise,
      ].join(','));
    }

    writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
    console.log(`exported ${rows.length} decisions to ${out}`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
