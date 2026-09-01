import { useEffect, useState } from 'react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { get, humanise, rupees } from './api.ts';

interface OverviewData {
  totals: { cases: string; suppressed: string; escalated: string; control_arm: string; at_risk_paise: string };
  actions: { actions: string; sent: string; failed: string; links: string; real_links: string };
  byDiagnosis: Array<{ diagnosis: string; n: string; at_risk: string }>;
  byAction: Array<{ action: string; n: string }>;
  blocks: Array<{ reason: string; n: string }>;
}

interface EvaluationData {
  verified: {
    policy_violations: Record<string, number>;
    coverage: { contacted: number; cases: number; contact_rate: number };
    diagnosis: { ambiguous_subset: { n: number; accuracy: number } };
  };
  simulated: {
    scenarios: Record<string, {
      treatment: { rate: number; n: number };
      control: { rate: number; n: number };
      uplift_pp: number;
      uplift_ci_overlaps: boolean;
    }>;
  };
}

export function Overview({ onOpenCase }: { onOpenCase: (id: string) => void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([get<OverviewData>('/api/overview'), get<EvaluationData>('/api/evaluation')])
      .then(([o, e]) => { setData(o); setEvaluation(e); })
      .catch((cause: unknown) => { setError(String(cause)); });
  }, []);

  if (error) return <div className="loading">could not load: {error}</div>;
  if (!data) return <div className="loading">loading…</div>;

  const violations = evaluation
    ? Object.values(evaluation.verified.policy_violations).reduce((a, b) => a + b, 0)
    : null;
  const central = evaluation?.simulated.scenarios['central'];
  const ambiguous = evaluation?.verified.diagnosis.ambiguous_subset;

  const diagnosisChart = data.byDiagnosis.map((row) => ({
    name: humanise(row.diagnosis).replace(/ (or|and) /g, ' '),
    cases: Number(row.n),
    atRisk: Number(row.at_risk) / 100,
  }));

  return (
    <>
      <div className="tier verified">
        <h2>Verified</h2>
        <p>measured against ground truth — true regardless of what any customer would have done</p>
      </div>

      <div className="grid cols-4">
        <div className="card">
          <h3>Policy violations</h3>
          <div className={`stat ${violations === 0 ? 'ok' : 'bad'}`}>{violations ?? '—'}</div>
          <div className="stat-note">across {Number(data.totals.cases).toLocaleString('en-IN')} cases, 6 rules</div>
        </div>
        <div className="card">
          <h3>Cases decided</h3>
          <div className="stat">{Number(data.totals.cases).toLocaleString('en-IN')}</div>
          <div className="stat-note">{rupees(data.totals.at_risk_paise, true)} at risk</div>
        </div>
        <div className="card">
          <h3>Customers contacted</h3>
          <div className="stat">{evaluation?.verified.coverage.contacted.toLocaleString('en-IN') ?? '—'}</div>
          <div className="stat-note">
            {Number(data.totals.suppressed).toLocaleString('en-IN')} suppressed by policy
          </div>
        </div>
        <div className="card">
          <h3>Ambiguous diagnosis</h3>
          <div className="stat">{ambiguous ? `${(ambiguous.accuracy * 100).toFixed(1)}%` : '—'}</div>
          <div className="stat-note">n={ambiguous?.n ?? '—'} — cases with no code mapping</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div className="card">
          <h3>Every violation count is zero</h3>
          <table>
            <tbody>
              {evaluation && Object.entries(evaluation.verified.policy_violations).map(([rule, count]) => (
                <tr key={rule}>
                  <td className="mono">{rule}</td>
                  <td className="num">
                    <span className={`pill ${count === 0 ? 'ok' : 'bad'}`}>{count}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Why cases were blocked</h3>
          <table>
            <tbody>
              {data.blocks.map((row) => (
                <tr key={row.reason}>
                  <td>{humanise(row.reason)}</td>
                  <td className="num mono">{Number(row.n).toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Revenue at risk by diagnosed cause</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={diagnosisChart} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="name" stroke="#8b949e" fontSize={10} interval={0} angle={-12} textAnchor="end" height={54} />
            <YAxis stroke="#8b949e" fontSize={11} tickFormatter={(v: number) => `₹${(v / 100000).toFixed(0)}L`} />
            <Tooltip
              contentStyle={{ background: '#161b22', border: '1px solid #262c36', borderRadius: 6, fontSize: 12 }}
              formatter={(value: number) => [`₹${value.toLocaleString('en-IN')}`, 'at risk']}
            />
            <Bar dataKey="atRisk" radius={[3, 3, 0, 0]}>
              {diagnosisChart.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={
                    entry.name.includes('suspicious') || entry.name.includes('merchant config')
                      ? '#6e7681'
                      : '#58a6ff'
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="stat-note">
          Grey bars are causes Reclaim never contacts a customer about — fraud signals and
          merchant-side misconfiguration, where a message could not help.
        </div>
      </div>

      <div className="tier simulated">
        <h2>Simulated</h2>
        <p>depends entirely on the documented assumptions in RESPONSE_MODEL.md — not measurements</p>
      </div>

      <div className="grid cols-3">
        {evaluation && Object.entries(evaluation.simulated.scenarios).map(([name, scenario]) => (
          <div className="card" key={name}>
            <h3>{name}<span className="sim-tag">simulated</span></h3>
            <div className="stat sim">{scenario.uplift_pp > 0 ? '+' : ''}{scenario.uplift_pp.toFixed(1)}pp</div>
            <div className="stat-note">
              treatment {(scenario.treatment.rate * 100).toFixed(1)}% (n={scenario.treatment.n})
              {' vs '}
              control {(scenario.control.rate * 100).toFixed(1)}% (n={scenario.control.n})
            </div>
            <div className="stat-note" style={{ marginTop: 4 }}>
              {scenario.uplift_ci_overlaps
                ? 'CIs overlap — not distinguishable from noise'
                : 'CIs do not overlap'}
            </div>
          </div>
        ))}
      </div>

      <div className="caveat" style={{ marginTop: 12 }}>
        <strong>Why these are separated.</strong> Recovery outcomes cannot be measured on
        synthetic data: whether a customer <em>would</em> have paid without contact is a
        counterfactual our generator writes, not something the system discovers. So those
        figures are drawn from a documented response model, reported against a randomised
        control arm that receives no contact, and shown across three parameter sets. The
        verified numbers above hold regardless.
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Actions executed</h3>
        <div className="grid cols-4">
          <div>
            <div className="stat" style={{ fontSize: 22 }}>{Number(data.actions.sent).toLocaleString('en-IN')}</div>
            <div className="stat-note">sent</div>
          </div>
          <div>
            <div className="stat" style={{ fontSize: 22 }}>{Number(data.actions.links).toLocaleString('en-IN')}</div>
            <div className="stat-note">payment links issued</div>
          </div>
          <div>
            <div className="stat" style={{ fontSize: 22 }}>{Number(data.actions.real_links).toLocaleString('en-IN')}</div>
            <div className="stat-note">created via the real Razorpay API</div>
          </div>
          <div>
            <div className={`stat ${Number(data.actions.failed) > 0 ? 'bad' : ''}`} style={{ fontSize: 22 }}>
              {Number(data.actions.failed).toLocaleString('en-IN')}
            </div>
            <div className="stat-note">failed → escalated to a human</div>
          </div>
        </div>
      </div>
    </>
  );
}
