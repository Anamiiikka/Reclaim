/**
 * Audit trail.
 *
 * The design constraint: an audit record must contain enough to reproduce the
 * decision byte-for-byte, without consulting any live table. That is why the whole
 * CaseSnapshot is stored rather than a case id — the live row will have moved on,
 * and a replay that reads current state proves nothing about a past decision.
 */

import type { Sql } from 'postgres';

import { decide } from './plan.js';
import { evaluatePolicy } from '../policy/rules.js';
import type { CaseSnapshot, Decision } from '../types.js';

export const EVENT_TYPES = [
  'CASE_DETECTED',
  'DECISION_MADE',
  'ACTION_SCHEDULED',
  'ACTION_EXECUTED',
  'ACTION_FAILED',
  'ACTION_RETRIED',
  'ESCALATED',
  'OUTCOME_RECORDED',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AuditRecord {
  readonly caseId: string;
  readonly actionId: string | null;
  readonly eventType: EventType;
  readonly decisionInput: CaseSnapshot | null;
  readonly decisionOutput: Decision | null;
  readonly explanation: string;
  readonly actor: string;
}

export async function writeAudit(sql: Sql, record: AuditRecord): Promise<void> {
  await sql`
    INSERT INTO audit_events (
      case_id, action_id, event_type, decision_input, decision_output, policy_checks, explanation, actor
    ) VALUES (
      ${record.caseId},
      ${record.actionId},
      ${record.eventType},
      ${record.decisionInput ? sql.json(record.decisionInput as never) : null},
      ${record.decisionOutput ? sql.json(record.decisionOutput as never) : null},
      ${record.decisionOutput ? sql.json(record.decisionOutput.policy.checks as never) : null},
      ${record.explanation},
      ${record.actor}
    )
  `;
}

/** Record a decision together with the exact inputs that produced it. */
export async function recordDecision(sql: Sql, snapshot: CaseSnapshot, decision: Decision): Promise<void> {
  await writeAudit(sql, {
    caseId: snapshot.caseId,
    actionId: null,
    eventType: 'DECISION_MADE',
    decisionInput: snapshot,
    decisionOutput: decision,
    explanation: decision.explanation,
    actor: 'system',
  });
}

export interface ReplayResult {
  readonly caseId: string;
  readonly identical: boolean;
  readonly original: Decision;
  readonly replayed: Decision;
  /** JSON paths that differ. Empty when the replay is faithful. */
  readonly differences: readonly string[];
}

/**
 * Re-run a stored decision from its stored inputs and compare.
 *
 * A mismatch means the decision layer stopped being a pure function of its input —
 * someone read a clock, a database, or a random number. Worth catching loudly.
 */
export async function replayDecision(sql: Sql, auditEventId: number): Promise<ReplayResult | null> {
  const rows = await sql<
    Array<{ case_id: string; decision_input: CaseSnapshot; decision_output: Decision }>
  >`
    SELECT case_id, decision_input, decision_output
    FROM audit_events
    WHERE id = ${auditEventId} AND event_type = 'DECISION_MADE'
  `;

  const row = rows[0];
  if (!row) return null;

  const snapshot = row.decision_input;
  const replayed = decide(snapshot, evaluatePolicy(snapshot));
  const differences = diff(row.decision_output, replayed);

  return {
    caseId: row.case_id,
    identical: differences.length === 0,
    original: row.decision_output,
    replayed,
    differences,
  };
}

/** Structural diff, reported as dotted paths so a mismatch is easy to locate. */
function diff(a: unknown, b: unknown, path = ''): string[] {
  if (a === b) return [];

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? [] : [`${path || '(root)'}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return [`${path}: array/object mismatch`];
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${path}: length ${a.length} → ${b.length}`];
    return a.flatMap((item, i) => diff(item, b[i], `${path}[${i}]`));
  }

  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    diff(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      path ? `${path}.${key}` : key,
    ),
  );
}
