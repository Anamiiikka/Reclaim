import { useEffect, useState } from 'react';

import { get, humanise, rupees } from './api.ts';

interface Report {
  verified: {
    diagnosis: {
      _caveat: string;
      accuracy: number;
      ambiguous_subset: { n: number; accuracy: number; _note: string };
      per_diagnosis: Record<string, { n: number; recall: number; precision: number }>;
    };
    policy_violations: Record<string, number>;
    coverage: Record<string, number>;
  };
  simulated: {
    response_model: string;
    caveats: string[];
    scenarios: Record<string, {
      treatment: { n: number; recovered: number; rate: number; rate_ci95: [number, number]; revenue_paise: number };
      control: { n: number; recovered: number; rate: number; rate_ci95: [number, number] };
      uplift_pp: number;
      uplift_ci_overlaps: boolean;
      like_for_like: {
        n: number;
        baseline_recovered: number;
        baseline_revenue_paise: number;
        baseline_contacts: number;
        reclaim_recovered: number;
        reclaim_revenue_paise: number;
        reclaim_contacts: number;
      };
    }>;
  };
}

export function Evaluation() {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => { get<Report>('/api/evaluation').then(setReport).catch(() => { setReport(null); }); }, []);

  if (!report) return <div className="loading">loading…</div>;

  const central = report.simulated.scenarios['central'];
  const like = central?.like_for_like;

  return (
    <>
      <div className="tier verified">
        <h2>Verified</h2>
        <p>measured against ground truth</p>
      </div>

      <div className="card">
        <h3>Diagnosis accuracy</h3>
        <div className="caveat" style={{ marginBottom: 14 }}>
          <strong>Overall accuracy is {(report.verified.diagnosis.accuracy * 100).toFixed(1)}%, and that is
          not a result.</strong> The generator writes a gateway failure code and the engine maps
          that same code back through the same table, so agreement is arithmetic rather than
          inference. The meaningful number is the ambiguous subset below — cases with an
          unrecognised code, where the engine has to fall back to heuristics.
        </div>
        <div className="grid cols-2">
          <div>
            <div className="stat">{(report.verified.diagnosis.ambiguous_subset.accuracy * 100).toFixed(1)}%</div>
            <div className="stat-note">
              on {report.verified.diagnosis.ambiguous_subset.n} genuinely ambiguous cases.
              The sample is small, and we say so.
            </div>
          </div>
          <table>
            <thead>
              <tr><th>Cause</th><th className="num">n</th><th className="num">Recall</th><th className="num">Precision</th></tr>
            </thead>
            <tbody>
              {Object.entries(report.verified.diagnosis.per_diagnosis)
                .sort((a, b) => b[1].n - a[1].n)
                .map(([label, m]) => (
                  <tr key={label}>
                    <td>{humanise(label)}</td>
                    <td className="num mono">{m.n}</td>
                    <td className="num mono">{m.recall.toFixed(2)}</td>
                    <td className="num mono">{m.precision.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="tier simulated">
        <h2>Simulated</h2>
        <p>depends on {report.simulated.response_model} — reported against a no-contact control arm</p>
      </div>

      <div className="card">
        <h3>Sensitivity across three parameter sets<span className="sim-tag">simulated</span></h3>
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="num">Treatment</th>
              <th className="num">Control</th>
              <th className="num">Uplift</th>
              <th>Distinguishable from noise</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(report.simulated.scenarios).map(([name, s]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="num mono">
                  {(s.treatment.rate * 100).toFixed(1)}%
                  <span className="dim"> [{(s.treatment.rate_ci95[0] * 100).toFixed(1)}–{(s.treatment.rate_ci95[1] * 100).toFixed(1)}]</span>
                </td>
                <td className="num mono">
                  {(s.control.rate * 100).toFixed(1)}%
                  <span className="dim"> [{(s.control.rate_ci95[0] * 100).toFixed(1)}–{(s.control.rate_ci95[1] * 100).toFixed(1)}]</span>
                </td>
                <td className="num mono sim">{s.uplift_pp > 0 ? '+' : ''}{s.uplift_pp.toFixed(1)}pp</td>
                <td>
                  <span className={`pill ${s.uplift_ci_overlaps ? 'warn' : 'ok'}`}>
                    {s.uplift_ci_overlaps ? 'no — CIs overlap' : 'yes'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="stat-note" style={{ marginTop: 10 }}>Wilson 95% intervals.</div>
      </div>

      {like && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Against a contact-everyone baseline<span className="sim-tag">simulated</span></h3>
          <p className="stat-note" style={{ marginTop: -6 }}>
            Restricted to the {like.n.toLocaleString('en-IN')} cases both policies may act on
            unaided, so the comparison isolates targeting rather than permission.
          </p>
          <table>
            <thead>
              <tr><th></th><th className="num">Reclaim</th><th className="num">Contact everyone</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Customers contacted</td>
                <td className="num mono">{like.reclaim_contacts.toLocaleString('en-IN')}</td>
                <td className="num mono">{like.baseline_contacts.toLocaleString('en-IN')}</td>
              </tr>
              <tr>
                <td>Recovered</td>
                <td className="num mono">{like.reclaim_recovered.toLocaleString('en-IN')}</td>
                <td className="num mono">{like.baseline_recovered.toLocaleString('en-IN')}</td>
              </tr>
              <tr>
                <td>Revenue</td>
                <td className="num mono">{rupees(like.reclaim_revenue_paise, true)}</td>
                <td className="num mono">{rupees(like.baseline_revenue_paise, true)}</td>
              </tr>
            </tbody>
          </table>
          <div className="caveat" style={{ marginTop: 12 }}>
            <strong>This is a trade-off, not a win.</strong> Contacting everyone recovers{' '}
            {rupees(like.baseline_revenue_paise - like.reclaim_revenue_paise)} more
            {' '}({(((like.baseline_revenue_paise - like.reclaim_revenue_paise) / like.reclaim_revenue_paise) * 100).toFixed(0)}%)
            {' '}by sending {(like.baseline_contacts - like.reclaim_contacts).toLocaleString('en-IN')} more messages
            {' '}({(((like.baseline_contacts - like.reclaim_contacts) / like.reclaim_contacts) * 100).toFixed(0)}%).
            Reclaim gives up some recovery to avoid contacting people it judges unlikely to
            convert. Whether that is the right call is a merchant’s decision — the floor that
            produces it is a single configurable threshold. What Reclaim provides is the
            ability to make that choice deliberately, and to see what it costs.
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Caveats</h3>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13 }}>
          {report.simulated.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
        </ul>
      </div>
    </>
  );
}
