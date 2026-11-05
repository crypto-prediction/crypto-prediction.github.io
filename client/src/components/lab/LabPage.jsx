// The Intelligence Lab: a separate page at /lab.html, so the dashboard itself stays untouched.
// It has its own live feed, and only the open tab fetches anything.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib.js';
import { baseOf, setCoins } from '../../coins.js';
import { useOverview } from '../../market.js';

const GROUPS = [
  ['Markets', [
    ['heatmap', 'Heatmap', lazy(() => import('./Heatmap.jsx'))],
    ['activity', 'Activity', lazy(() => import('./Activity.jsx'))],
    ['orderbook', 'Order book', lazy(() => import('./OrderBook.jsx'))],
    ['futures', 'Futures', lazy(() => import('./Futures.jsx'))],
    ['liquidations', 'Liquidations', lazy(() => import('./Liquidations.jsx'))],
    ['exchanges', 'Exchanges', lazy(() => import('./Exchanges.jsx'))],
  ]],
  ['Research', [
    ['forecast', 'Forecasts', lazy(() => import('./Forecast.jsx'))],
    ['intel', 'Analyst', lazy(() => import('./Analyst.jsx'))],
    ['tracker', 'Model tracker', lazy(() => import('./Tracker.jsx'))],
    ['news', 'News', lazy(() => import('./News.jsx'))],
    ['calendar', 'Calendar', lazy(() => import('./Calendar.jsx'))],
    ['reports', 'Reports', lazy(() => import('./Reports.jsx'))],
  ]],
  ['Strategy', [
    ['builder', 'Strategy builder', lazy(() => import('./StrategyBuilder.jsx'))],
    ['backtest', 'Backtest lab', lazy(() => import('./BacktestLab.jsx'))],
    ['replay', 'Market replay', lazy(() => import('./Replay.jsx'))],
  ]],
  ['Portfolio', [
    ['portfolio', 'Portfolio', lazy(() => import('./PortfolioIntel.jsx'))],
    ['risk', 'Risk simulator', lazy(() => import('./RiskSimulator.jsx'))],
    ['journal', 'Trading journal', lazy(() => import('./Journal.jsx'))],
  ]],
  ['Automation', [
    ['alerts', 'Alerts', lazy(() => import('./Alerts.jsx'))],
    ['autopilot', 'Autopilot', lazy(() => import('./Autopilot.jsx'))],
  ]],
];
const TABS = GROUPS.flatMap(([group, tabs]) => tabs.map(([key, label, Component]) => ({ group, key, label, Component })));
const OVERVIEW_INTERVAL = '1h';

/** Live tickers and alerts from the server, on this page's own connection. */
function useLabFeed(onAlert) {
  const [tickers, setTickers] = useState({});
  const pending = useRef({});
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;

  useEffect(() => {
    let stopped = false, retry = 0, timer, ws;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: 'alerts' })); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'ticker') pending.current[m.data.symbol] = { ...m.data, receivedAt: Date.now() };
        else if (m.type === 'alert') alertRef.current?.(m.data);
        else if (m.type === 'autopilot') alertRef.current?.({ ...m.data, fromAutopilot: true });
      };
      ws.onclose = () => { if (!stopped) timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++)); };
    };
    connect();
    const flush = setInterval(() => {
      if (!Object.keys(pending.current).length) return;
      const batch = pending.current;
      pending.current = {};
      setTickers((t) => ({ ...t, ...batch }));
    }, 500);
    return () => { stopped = true; clearTimeout(timer); clearInterval(flush); ws?.close(); };
  }, []);
  return tickers;
}

export default function LabPage() {
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState('');
  const [symbol, setSymbol] = useState(null);
  const [restTickers, setRestTickers] = useState({});
  const [tab, setTabState] = useState(() => {
    const wanted = location.hash.slice(1);
    return TABS.some((t) => t.key === wanted) ? wanted : 'heatmap';
  });
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState(null);
  const [lastAlert, setLastAlert] = useState(null);
  const markRead = useCallback(() => setUnread(0), []);

  const setTab = (key) => {
    setTabState(key);
    history.replaceState(null, '', `#${key}`);
  };

  useEffect(() => {
    const onHash = () => {
      const wanted = location.hash.slice(1);
      if (TABS.some((t) => t.key === wanted)) setTabState(wanted);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const onAlert = useCallback((a) => {
    setToast(a);
    if (a.fromAutopilot) return;
    setLastAlert(a);
    setUnread((n) => n + 1);
  }, []);
  const tickers = useLabFeed(onAlert);
  const overview = useOverview(Boolean(meta), OVERVIEW_INTERVAL);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let cancelled = false, timer;
    const load = () => api('/api/meta').then((m) => {
      if (cancelled) return;
      setCoins(m.coins);
      setMeta(m);
      setSymbol((s) => s || m.symbols[0] || null);
      setMetaError('');
    }).catch((e) => {
      if (cancelled) return;
      setMetaError(e.message);
      timer = setTimeout(load, 5000);
    });
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const load = () => api('/api/tickers').then((r) => setRestTickers(Object.fromEntries(r.tickers.map((t) => [t.symbol, t])))).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { api('/api/alerts/events?limit=1').then((r) => setUnread(r.unread)).catch(() => {}); }, []);

  if (!meta || !symbol) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        {metaError
          ? <p role="alert" className="max-w-md text-sm text-rose-neon">{metaError} Retrying…</p>
          : <p role="status" className="text-sm text-mute">Loading the coin list…</p>}
      </div>
    );
  }

  const active = TABS.find((t) => t.key === tab);
  const Active = active.Component;
  const shared = { symbol, onSelect: setSymbol, symbols: meta.symbols, tickers, restTickers, overview, meta, lastAlert, onAlertsRead: markRead, overviewInterval: OVERVIEW_INTERVAL };

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6" data-lab-page>
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-700 pb-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-wide">Intelligence<span className="text-cyan-neon">Lab</span> <span className="text-mute">/ Signal Lab research</span></h1>
          <p className="text-xs text-mute">Research from real market data. Past results and estimates are not guarantees or financial advice.</p>
        </div>
        <a href="/" className="btn btn-ghost" data-back>Back to dashboard</a>
      </header>
      <nav className="flex flex-col gap-1.5" aria-label="Intelligence Lab sections">
        {GROUPS.map(([group, tabs]) => (
          <div key={group} className="flex flex-wrap items-center gap-1">
            <span className="label w-20 shrink-0">{group}</span>
            {tabs.map(([key, label]) => (
              <button key={key} type="button" data-lab-tab={key} className="seg" aria-pressed={tab === key} onClick={() => setTab(key)}>
                {label}{key === 'alerts' && unread > 0 ? ` (${unread})` : ''}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <Suspense fallback={<p role="status" className="text-sm text-mute">Loading…</p>}>
        <Active {...shared} />
      </Suspense>
      {toast && (
        <div role="status" data-alert-toast className="panel fixed bottom-4 right-4 z-50 max-w-xs border-amber-neon/60 text-xs text-slate-200">
          <div className="label text-amber-neon">{toast.fromAutopilot ? 'Autopilot' : 'Alert'} · {baseOf(toast.symbol)}</div>
          {toast.message}
        </div>
      )}
    </div>
  );
}
