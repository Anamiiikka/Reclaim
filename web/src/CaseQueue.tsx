import { useEffect, useState } from 'react';

import { actionTone, get, humanise, rupees } from './api.ts';

interface CaseRow {
  id: string;
  status: string;
  diagnosis: string | null;
  arm: string;
  amount_paise: string;
  confidence: string | null;
  recovery_probability: string | null;
  action: string | null;
  requires_approval: boolean | null;
  action_status: string | null;
  payment_link_url: string | null;
}

interface Page {
  rows: CaseRow[];
  total: number;
  limit: number;
  offset: number;
}

const STATUSES = ['DECIDED', 'SUPPRESSED', 'ESCALATED'];
const DIAGNOSES = [
  'TEMPORARY_BANK_OR_NETWORK_FAILURE',
  'INSUFFICIENT_FUNDS',
  'EXPIRED_PAYMENT_METHOD',
  'USER_ABANDONMENT',
  'DUPLICATE_OR_REPEAT_ATTEMPT',
  'SUSPICIOUS_ACTIVITY',
  'MERCHANT_CONFIGURATION_ERROR',
  'UNKNOWN',
];

export function CaseQueue({ onOpenCase }: { onOpenCase: (id: string) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [status, setStatus] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({ limit: '50', offset: String(offset) });
    if (status) params.set('status', status);
    if (diagnosis) params.set('diagnosis', diagnosis);
    get<Page>(`/api/cases?${params.toString()}`).then(setPage).catch(() => { setPage(null); });
  }, [status, diagnosis, offset]);

  return (
    <>
      <div className="filters">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">all statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{humanise(s)}</option>)}
        </select>
        <select value={diagnosis} onChange={(e) => { setDiagnosis(e.target.value); setOffset(0); }}>
          <option value="">all causes</option>
          {DIAGNOSES.map((d) => <option key={d} value={d}>{humanise(d)}</option>)}
        </select>
        {page && (
          <span className="muted" style={{ alignSelf: 'center' }}>
            {page.total.toLocaleString('en-IN')} cases · sorted by amount at risk
          </span>
        )}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th className="num">At risk</th>
              <th>Diagnosed cause</th>
              <th className="num">Est.</th>
              <th>Planned action</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((row) => (
              <tr key={row.id} className="clickable" onClick={() => { onOpenCase(row.id); }}>
                <td className="mono">
                  {row.id}
                  {row.arm === 'CONTROL' && <span className="pill warn" style={{ marginLeft: 6 }}>control</span>}
                </td>
                <td className="num">{rupees(row.amount_paise)}</td>
                <td>{humanise(row.diagnosis)}</td>
                <td className="num mono dim">
                  {row.recovery_probability === null
                    ? '—'
                    : `${(Number(row.recovery_probability) * 100).toFixed(0)}%`}
                </td>
                <td>
                  <span className={`pill ${actionTone(row.action)}`}>{humanise(row.action)}</span>
                  {row.requires_approval && <span className="pill warn" style={{ marginLeft: 6 }}>needs approval</span>}
                </td>
                <td>
                  {row.payment_link_url ? (
                    <a href={row.payment_link_url} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); }}>
                      link sent
                    </a>
                  ) : (
                    <span className="dim">{humanise(row.action_status ?? row.status)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {page && page.total > page.limit && (
          <div className="filters" style={{ marginTop: 12, marginBottom: 0 }}>
            <button className="back" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); }}>
              ← previous
            </button>
            <span className="muted" style={{ alignSelf: 'center' }}>
              {offset + 1}–{Math.min(offset + page.limit, page.total)} of {page.total.toLocaleString('en-IN')}
            </span>
            <button
              className="back"
              disabled={offset + page.limit >= page.total}
              onClick={() => { setOffset(offset + 50); }}
            >
              next →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
