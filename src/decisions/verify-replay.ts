/**
 * Replay every stored decision from its stored inputs and confirm it reproduces
 * byte-for-byte.
 *
 * A mismatch means the decision layer stopped being a pure function of its input —
 * a clock read, a database lookup, a random number. That would invalidate the audit
 * trail, so it is worth checking against the whole corpus rather than a sample.
 *
 *   npx tsx src/decisions/verify-replay.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

import { decide } from './plan.js';
import { evaluatePolicy } from '../policy/rules.js';
import type { CaseSnapshot, Decision } from '../types.js';

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

/** Stable stringify: key order must not decide whether a replay "matches". */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

async function main(): Promise<void> {
  const sql = postgres(loadDatabaseUrl(), { ssl: 'require', max: 5 });
  const started = Date.now();

  try {
    const rows = await sql<Array<{ id: string; decision_input: CaseSnapshot; decision_output: Decision }>>`
      SELECT id, decision_input, decision_output
      FROM audit_events
      WHERE event_type = 'DECISION_MADE'
      ORDER BY id
    `;

    let identical = 0;
    const mismatches: Array<{ id: string; caseId: string }> = [];

    for (const row of rows) {
      const snapshot = row.decision_input;
      const replayed = decide(snapshot, evaluatePolicy(snapshot));
      if (canonical(replayed) === canonical(row.decision_output)) {
        identical += 1;
      } else {
        mismatches.push({ id: row.id, caseId: snapshot.caseId });
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`replayed ${rows.length} decisions in ${elapsed}s`);
    console.log(`  identical  ${identical}`);
    console.log(`  mismatched ${mismatches.length}`);

    if (mismatches.length > 0) {
      console.log('\nfirst mismatches:');
      for (const m of mismatches.slice(0, 5)) console.log(`  audit ${m.id} (case ${m.caseId})`);
      process.exitCode = 1;
      return;
    }

    console.log('\nevery stored decision reproduces exactly from its recorded inputs.');
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
