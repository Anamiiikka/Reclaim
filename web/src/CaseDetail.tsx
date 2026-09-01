import { useEffect, useState } from 'react';

import { actionTone, get, humanise, rupees, shortTime } from './api.ts';

interface PolicyCheck {
  rule: string;
  passed: boolean;
  reason: string | null;
  detail: string;
}

interface TimelineEvent {
  id: number;
  event_type: string;
  occurred_at: string;
  explanation: string;
  actor: string;
  policy_checks: PolicyCheck[] | null;
  planned: { action: string; delayMinutes: number; requiresApproval: boolean; rationale: string } | null;
}

interface ActionRow {
  id: string;
  action: string;
  status: string;
  attempt_count: number;
  idempotency_key: string;
  payment_link_id: string | null;
  payment_link_url: string | null;
  scheduled_for: string;
  executed_at: string | null;
  last_error: string | null;
}

interface Detail {
  case: Record<string, string | number | boolean | null>;
  timeline: TimelineEvent[];
  actions: ActionRow[];
}

const EVENT_TONE: Record<string, string> = {
  DECISION_MADE: 'ok',
  ACTION_SCHEDULED: '',
  ACTION_EXECUTED: 'ok',
  ACTION_FAILED: 'warn',
  ESCALATED: 'bad',
};

export function CaseDetail({ caseId, onBack }: { caseId: string; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    get<Detail>(`/api/cases/${caseId}`)
      .then(setData)
      .catch((cause: unknown) => { setError(String(cause)); });
  }, [caseId]);

  if (error) return <div className="loading">could not load {caseId}: {error}</div>;
  if (!data) return <div className="loading">loading…</div>;

  const c = data.case;
  const decision = data.timeline.find((event) => event.event_type === 'DECISION_MADE');
  const checks = decision?.policy_checks ?? [];
  const failed = checks.filter((check) => !check.passed);

  return (
    <>
      <button className="back" onClick={onBack}>← all cases</button>

      <div className="grid cols-2">
        <div className="card">
          <h3>Case {String(c['id'])}</h3>
          <div className="stat">{rupees(String(c['amount_at_risk_paise']))}</div>
          <div className="stat-note">
            {String(c['merchant_name'])} · {String(c['city'])} ·{' '}
            {humanise(String(c['payment_method']))}
          </div>
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>Failure code</dt>
            <dd className="mono">{String(c['failure_code'] ?? '— none supplied')}</dd>
            <dt>Diagnosed as</dt>
            <dd>
              {humanise(String(c['diagnosis']))}{' '}
              <span className="dim">confidence {Number(c['diagnosis_confidence']).toFixed(2)}</span>
            </dd>
            <dt>Recovery estimate</dt>
            <dd>
              {c['recovery_probability'] === null
                ? <span className="dim">not scored</span>
                : <>{(Number(c['recovery_probability']) * 100).toFixed(0)}%<span className="sim-tag">model</span></>}
            </dd>
            <dt>Experiment arm</dt>
            <dd>
              <span className={`pill ${c['arm'] === 'CONTROL' ? 'warn' : ''}`}>{String(c['arm'])}</span>
              {c['arm'] === 'CONTROL' && (
                <span className="dim"> — withheld to measure uplift</span>
              )}
            </dd>
            <dt>Customer history</dt>
            <dd>
              {String(c['prior_success_count'])} paid, {String(c['prior_failure_count'])} failed
              {c['is_opted_out'] === true && <span className="pill bad" style={{ marginLeft: 8 }}>opted out</span>}
            </dd>
            <dt>Recovery window</dt>
            <dd className="dim">closes {shortTime(String(c['expires_at']))}</dd>
          </dl>
        </div>

        <div className="card">
          <h3>Policy checks — all {checks.length} ran</h3>
          <p className="stat-note" style={{ marginTop: -6, marginBottom: 10 }}>
            Every rule is evaluated and reported, rather than stopping at the first block, so
            a merchant asking “why wasn’t this customer contacted?” sees the whole picture.
          </p>
          <div className="checks">
            {checks.map((check) => (
              <div key={check.rule} className={`check ${check.passed ? 'passed' : 'failed'}`}>
                <span className="mark">{check.passed ? '✓' : '✕'}</span>
                <span className="rule">{check.rule}</span>
                <span className="detail">{check.detail}</span>
              </div>
            ))}
          </div>
          {failed.length > 0 && (
            <div className="stat-note" style={{ marginTop: 12 }}>
              {failed.length} rule{failed.length === 1 ? '' : 's'} blocked this case.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Decision timeline</h3>
        <div className="timeline">
          {data.timeline.map((event) => (
            <div key={event.id} className={`timeline-item ${EVENT_TONE[event.event_type] ?? ''}`}>
              <div className="timeline-head">
                <strong>{humanise(event.event_type)}</strong>
                <span className="timeline-time">{shortTime(event.occurred_at)}</span>
                <span className="pill">{event.actor}</span>
              </div>
              <div className="timeline-body">{event.explanation}</div>
            </div>
          ))}
        </div>
      </div>

      {data.actions.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Actions</h3>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Idempotency key</th>
                <th>Payment link</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.map((action) => (
                <tr key={action.id}>
                  <td><span className={`pill ${actionTone(action.action)}`}>{humanise(action.action)}</span></td>
                  <td>
                    <span className={`pill ${action.status === 'SENT' ? 'ok' : action.status === 'FAILED' ? 'bad' : 'warn'}`}>
                      {humanise(action.status)}
                    </span>
                  </td>
                  <td className="num mono">{action.attempt_count}</td>
                  <td className="mono dim">{action.idempotency_key.slice(0, 18)}…</td>
                  <td>
                    {action.payment_link_url ? (
                      <a href={action.payment_link_url} target="_blank" rel="noreferrer" className="mono">
                        {action.payment_link_id}
                      </a>
                    ) : (
                      <span className="dim">
                        {action.last_error ? 'none — no customer was contacted' : '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.actions.some((a) => a.last_error) && (
            <div className="caveat" style={{ marginTop: 12 }}>
              <strong>Failure handled.</strong>{' '}
              {data.actions.find((a) => a.last_error)?.last_error}
              {' — '}the action was retried once under the same idempotency key, then escalated.
              No payment link was issued, so no customer was contacted twice.
            </div>
          )}
        </div>
      )}
    </>
  );
}
