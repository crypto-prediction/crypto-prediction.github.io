import { useEffect, useRef, useState, useCallback } from 'react';
import { api, fmt, fmtSig, pct, time } from '../lib.js';
import { baseOf, nameOf } from '../coins.js';

const SIG = {
  BUY: 'border-lime-neon/60 text-lime-neon bg-lime-neon/10',
  SELL: 'border-rose-neon/60 text-rose-neon bg-rose-neon/10',
  HOLD: 'border-amber-neon/60 text-amber-neon bg-amber-neon/10',
};
const HORIZONS = [6, 12, 24, 48];

export function AnalysisPanel({ symbol, interval, refreshKey }) {
  const [a, setA] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [horizon, setHorizon] = useState(12);
  const [ai, setAi] = useState(null);
  const [aiErr, setAiErr] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    try {
      const r = await api(`/api/analysis?symbol=${symbol}&interval=${interval}&horizon=${horizon}`);
      if (id !== latest.current) return; // a newer request has replaced this one
      setA(r);
      setErr('');
    } catch (e) { if (id === latest.current) setErr(e.message); }
    finally { if (id === latest.current) setLoading(false); }
  }, [symbol, interval, horizon]);

  useEffect(() => { setAi(null); setAiErr(''); load(); }, [load, refreshKey]);
  useEffect(() => { setA(null); setErr(''); }, [symbol, interval]);
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  async function explain() {
    setAiLoading(true); setAiErr('');
    const asked = latest.current;
    try {
      const r = await api('/api/analysis/explain', { method: 'POST', body: { symbol, interval, horizon } });
      if (asked === latest.current) setAi(r);
    }
    catch (e) { setAiErr(e.message); }
    finally { setAiLoading(false); }
  }

  const title = `AI research signal · ${nameOf(symbol)} (${baseOf(symbol)})`;
  if (err && !a) return <section className="panel"><div className="panel-title">{title}</div><p role="alert" className="text-sm text-rose-neon">Analysis unavailable: {err}</p><button className="btn btn-ghost mt-3" onClick={load}>Try again</button></section>;
  if (!a || a.symbol !== symbol || a.interval !== interval) return <section className="panel"><div className="panel-title">{title}</div><p role="status" className="text-sm text-mute">Analysing real {baseOf(symbol)} candles…</p></section>;
  const ev = a.evidence;
  const hold = a.signal === 'HOLD';
  return (
    <section className="panel flex flex-col gap-4">
      <div className="panel-title">
        <span>{title}</span>
        <span className="num font-normal normal-case tracking-normal text-mute">{loading ? 'updating…' : `as of ${time(a.asOfCandleClose + 1)}`}</span>
      </div>
      {err && <p role="alert" className="text-xs text-rose-neon">Refresh failed: {err}. Showing the previous reading.</p>}

      <div className="flex items-center gap-4">
        <div className={`rounded border px-4 py-2 font-display text-2xl font-bold tracking-wider ${SIG[a.signal]}`}>{a.signal}</div>
        <div className="flex-1">
          <div className="flex justify-between"><span className="label">Signal strength</span><span className="num text-sm">{a.confidence}/100</span></div>
          <div className="mt-1 h-1.5 rounded bg-ink-700"><div className="h-full rounded bg-gradient-to-r from-cyan-neon to-violet-neon" style={{ width: `${a.confidence}%` }} /></div>
          <div className="mt-1 text-[11px] text-mute">{a.agreementPct}% of indicator weight agrees · score {fmt(a.score, 3)} (BUY ≥ {a.thresholds.buy}, SELL ≤ {a.thresholds.sell})</div>
        </div>
      </div>

      {a.market && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-ink-700 bg-ink-700 sm:grid-cols-4">
          {[
            ['Trend', a.market.trend],
            ['RSI 14', fmt(a.market.rsi, 1)],
            ['MACD hist', fmtSig(a.market.macdHistogram)],
            ['Momentum', pct(a.market.momentumPct)],
          ].map(([k, v]) => <div key={k} className="bg-ink-900 px-3 py-1.5"><div className="label">{k}</div><div className="num text-sm">{v}</div></div>)}
        </div>
      )}

      <div className="rounded border border-ink-700 bg-ink-950/60 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="label">Historical evidence on this data</span>
          <div className="flex gap-1" role="group" aria-label="Horizon in candles">
            {HORIZONS.map((h) => <button key={h} className="seg num" aria-pressed={horizon === h} onClick={() => setHorizon(h)}>{h} bars</button>)}
          </div>
        </div>
        {ev.occurrences === 0 ? <p className="text-sm text-mute">No past {a.signal} readings in the last {a.barsAnalyzed} candles.</p> : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><div className="label">{hold ? 'Price rose' : 'Profitable after costs'}</div><div className="num text-lg">{pct(ev.hitRate * 100, 1, false)}</div><div className="num text-[11px] text-mute">95% CI {pct(ev.hitRateCI95[0] * 100, 0, false)}–{pct(ev.hitRateCI95[1] * 100, 0, false)}</div></div>
            <div><div className="label">Occurrences</div><div className="num text-lg">{ev.occurrences}</div><div className="text-[11px] text-mute">past {a.signal} bars</div></div>
            <div><div className="label">Avg move</div><div className="num text-lg">{pct(ev.meanForwardReturn * 100)}</div><div className="num text-[11px] text-mute">median {pct(ev.medianForwardReturn * 100)}</div></div>
            <div><div className="label">Baseline: any bar</div><div className="num text-lg">{pct(ev.baselineUpRate * 100, 1, false)}</div><div className="text-[11px] text-mute">price rose {ev.horizon} bars later</div></div>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-mute">{ev.note} Compare it with the baseline: a hit rate close to the baseline means the signal added little.</p>
      </div>

      <div>
        <div className="label mb-1">Supporting indicators</div>
        <div className="divide-y divide-ink-700 text-sm">
          {a.components.map((c) => (
            <div key={c.key} className="grid grid-cols-[1fr_auto] items-center gap-2 py-1.5 sm:grid-cols-[150px_1fr_64px]">
              <span className="text-slate-300">{c.name}</span>
              <span className="hidden text-xs text-mute sm:block">{c.reading}</span>
              <div className="flex items-center justify-end gap-2">
                <div className="relative h-1.5 w-10 rounded bg-ink-700">
                  <div className={`absolute top-0 h-full rounded ${c.score >= 0 ? 'left-1/2 bg-lime-neon' : 'right-1/2 bg-rose-neon'}`} style={{ width: `${Math.abs(c.score) * 50}%` }} />
                </div>
                <span className={`num w-9 text-right text-xs ${c.score > 0 ? 'text-lime-neon' : c.score < 0 ? 'text-rose-neon' : 'text-mute'}`}>{c.score > 0 ? '+' : ''}{c.score.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-violet-neon/30 bg-violet-neon/5 p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="label text-violet-neon">Plain-language explanation</span>
          {a.aiAvailable && <button className="btn btn-ghost py-1" onClick={explain} disabled={aiLoading}>{aiLoading ? 'Writing…' : ai ? 'Refresh' : 'Explain'}</button>}
        </div>
        {!a.aiAvailable && <p className="text-xs text-mute">Off. Add an ANTHROPIC_API_KEY on the server to have Claude explain each reading in plain language. The signal above never depends on it.</p>}
        {aiErr && <p role="alert" className="text-xs text-rose-neon">{aiErr}</p>}
        {ai && <p className="text-sm leading-relaxed text-slate-300">{ai.text}</p>}
        {ai && <p className="num mt-1 text-[10px] text-mute">{ai.model} · {time(ai.generatedAt)}</p>}
      </div>

      <p className="text-[11px] leading-relaxed text-mute">
        <strong className="text-slate-300">Signal strength is not a probability of profit.</strong> It measures how strongly the indicators agree right now. The historical hit rate is a past frequency on {a.barsAnalyzed} {interval} candles from {a.source}; markets change and it is not a forecast. This is research, not financial advice.
      </p>
    </section>
  );
}
