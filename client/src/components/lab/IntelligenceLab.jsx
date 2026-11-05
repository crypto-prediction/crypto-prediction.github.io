// Optional overlay holding the intelligence features. The dashboard underneath is untouched: this adds
// one small floating button, and only the open tab runs, so a closed lab costs nothing.
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api } from '../../lib.js';
import { baseOf } from '../../coins.js';

const TABS = [
  ['heatmap', 'Heatmap', lazy(() => import('./Heatmap.jsx'))],
  ['forecast', 'Forecasts', lazy(() => import('./Forecast.jsx'))],
  ['intel', 'Analyst', lazy(() => import('./Analyst.jsx'))],
  ['tracker', 'Model tracker', lazy(() => import('./Tracker.jsx'))],
  ['alerts', 'Alerts', lazy(() => import('./Alerts.jsx'))],
  ['portfolio', 'Portfolio', lazy(() => import('./PortfolioIntel.jsx'))],
  ['activity', 'Activity', lazy(() => import('./Activity.jsx'))],
  ['backtest', 'Backtest lab', lazy(() => import('./BacktestLab.jsx'))],
  ['news', 'News', lazy(() => import('./News.jsx'))],
];

export function IntelligenceLab({ open, setOpen, lastAlert, ...shared }) {
  const [tab, setTab] = useState('heatmap');
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState(null);
  const markRead = useCallback(() => setUnread(0), []);

  useEffect(() => { api('/api/alerts/events?limit=1').then((r) => setUnread(r.unread)).catch(() => {}); }, []);

  // a new alert from the server: count it and show it briefly
  useEffect(() => {
    if (!lastAlert) return undefined;
    setUnread((n) => n + 1);
    setToast(lastAlert);
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [lastAlert]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    // one scrollbar while the lab is open; the page keeps its scroll position underneath
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, setOpen]);

  const Active = TABS.find(([k]) => k === tab)[2];

  return (
    <div data-lab className="contents">
      {!open && (
        <button type="button" data-lab-open onClick={() => setOpen(true)} className="btn btn-cyan fixed bottom-4 right-4 z-30 bg-ink-950/95 shadow-glow">
          Intelligence Lab{unread > 0 && <span className="num ml-2 rounded bg-amber-neon/20 px-1.5 text-amber-neon">{unread}</span>}
        </button>
      )}

      {toast && (
        <div role="status" data-alert-toast className="panel fixed bottom-16 right-4 z-50 max-w-xs border-amber-neon/60 text-xs text-slate-200">
          <div className="label text-amber-neon">Alert · {baseOf(toast.symbol)}</div>
          {toast.message}
        </div>
      )}

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Intelligence Lab" className="fixed inset-0 z-40 overflow-y-auto overscroll-contain bg-ink-950">
          <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 pb-3">
              <div>
                <h2 className="font-display text-xl font-bold tracking-wide">Intelligence<span className="text-cyan-neon">Lab</span></h2>
                <p className="text-xs text-mute">Research from real market data. Past results and estimates are not guarantees or financial advice.</p>
              </div>
              <button type="button" autoFocus className="btn btn-ghost" onClick={() => setOpen(false)}>Back to dashboard</button>
            </header>
            <nav className="flex flex-wrap gap-1" aria-label="Intelligence Lab sections">
              {TABS.map(([k, label]) => (
                <button key={k} type="button" data-lab-tab={k} className="seg" aria-pressed={tab === k} onClick={() => setTab(k)}>
                  {label}{k === 'alerts' && unread > 0 ? ` (${unread})` : ''}
                </button>
              ))}
            </nav>
            <Suspense fallback={<p role="status" className="text-sm text-mute">Loading…</p>}>
              <Active {...shared} onAlertsRead={markRead} lastAlert={lastAlert} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
