import { useEffect, useState } from 'react';

import { Overview } from './Overview.tsx';
import { CaseQueue } from './CaseQueue.tsx';
import { CaseDetail } from './CaseDetail.tsx';
import { Evaluation } from './Evaluation.tsx';

type Tab = 'overview' | 'queue' | 'evaluation';

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [openCase, setOpenCase] = useState<string | null>(null);

  // Deep links matter for the demo: the video needs to jump straight to a case.
  useEffect(() => {
    const applyHash = () => {
      const match = /^#\/case\/([\w-]+)$/.exec(window.location.hash);
      setOpenCase(match?.[1] ?? null);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => { window.removeEventListener('hashchange', applyHash); };
  }, []);

  const openDetail = (id: string) => { window.location.hash = `#/case/${id}`; };
  const closeDetail = () => { window.location.hash = ''; };

  return (
    <div className="app">
      <header className="masthead">
        <h1>Reclaim</h1>
        <span className="tagline">safe, explainable revenue recovery</span>
        <nav className="tabs">
          {(['overview', 'queue', 'evaluation'] as const).map((name) => (
            <button
              key={name}
              className={tab === name && !openCase ? 'active' : ''}
              onClick={() => { closeDetail(); setTab(name); }}
            >
              {name === 'queue' ? 'Cases' : name[0]!.toUpperCase() + name.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {openCase ? (
        <CaseDetail caseId={openCase} onBack={closeDetail} />
      ) : tab === 'overview' ? (
        <Overview onOpenCase={openDetail} />
      ) : tab === 'queue' ? (
        <CaseQueue onOpenCase={openDetail} />
      ) : (
        <Evaluation />
      )}
    </div>
  );
}
