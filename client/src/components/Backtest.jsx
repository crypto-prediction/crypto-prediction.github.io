import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt, pct, price, usd, tone, time } from '../lib.js';
import { baseOf, nameOf } from '../coins.js';
import { LineChart, C } from './Charts.jsx';

const PF = (v) => (v === null || v === undefined ? '—' : v === Infinity ? '∞' : fmt(v, 2));

export function BacktestPanel({ meta, symbol, interval }) {
  const strategies = meta?.strategies || {};
  const [type, setType] = useState('ema_cross');
  const [params, setParams] = useState({});
  const [bars, setBars] = useState(1000);
  const [feePct, setFeePct] = useState(0.1);
  const [slip, setSlip] = useState(5);
  const [oos, setOos] = useState(30);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const def = strategies[type];
  useEffect(() => {
    if (!def) return;
    setParams(Object.fromEntries(Object.entries(def.params).map(([k, [d]]) => [k, d])));
  }, [type, def]);

  // A result belongs to one coin and interval: switching clears it, and a late answer is ignored.
  const runId = useRef(0);
  useEffect(() => { runId.current++; setRes(null); setErr(''); setBusy(false); }, [symbol, interval]);

  async function run(e) {
    e.preventDefault();
    const id = ++runId.current;
    setBusy(true); setErr('');
    try {
      const r = await api('/api/backtest', { method: 'POST', body: { symbol, interval, strategy: type, params, bars, feePct, slippageBps: slip, outOfSamplePct: oos } });
      if (id === runId.current) setRes(r);
    } catch (x) { if (id === runId.current) setErr(x.message); }
    finally { if (id === runId.current) setBusy(false); }
  }

  const series = useMemo(() => (res ? [
    { data: res.buyHold, color: 'rgba(125,135,152,.8)', width: 1 },
    { data: res.equity, color: C.cyan, width: 2 },
  ] : []), [res]);

  const m = res?.metrics;
  return (
    <section className="panel">
      <div className="panel-title"><span>Backtesting engine</span><span className="font-normal normal-case tracking-normal text-mute">{nameOf(symbol)} · {baseOf(symbol)}/USDT · {interval} · real Binance history</span></div>
      <form onSubmit={run} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="col-span-2 flex flex-col gap-1 sm:col-span-3 lg:col-span-2">
          <span className="label">Strategy</span>
          <select id="bt-strategy" className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(strategies).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <span className="text-[11px] text-mute">{def?.description}</span>
        </label>
        {def && Object.entries(def.params).map(([k, [, min, max]]) => (
          <label key={k} className="flex flex-col gap-1">
            <span className="label">{k} ({min}–{max})</span>
            <input id={`bt-${k}`} className="field num" type="number" min={min} max={max} value={params[k] ?? ''} onChange={(e) => setParams((p) => ({ ...p, [k]: e.target.value }))} />
          </label>
        ))}
        <label className="flex flex-col gap-1">
          <span className="label">Candles</span>
          <select id="bt-bars" className="field num" value={bars} onChange={(e) => setBars(Number(e.target.value))}>
            {[500, 1000, 2000, 3000, 5000].map((b) => <option key={b} value={b}>{b.toLocaleString()}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Fee % per fill</span>
          <input id="bt-fee" className="field num" type="number" step="0.01" min="0" max="1" value={feePct} onChange={(e) => setFeePct(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Slippage bps</span>
          <input id="bt-slip" className="field num" type="number" step="1" min="0" max="100" value={slip} onChange={(e) => setSlip(Number(e.target.value))} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Out-of-sample %</span>
          <input id="bt-oos" className="field num" type="number" step="5" min="10" max="50" value={oos} onChange={(e) => setOos(Number(e.target.value))} />
        </label>
        <div className="col-span-2 flex items-end sm:col-span-3 lg:col-span-6">
          <button className="btn btn-cyan" disabled={busy}>{busy ? 'Fetching history and testing…' : 'Run backtest'}</button>
        </div>
      </form>
      <p className="mt-2 text-[11px] text-mute">Signals are read at each candle's close and filled at the next candle's open, with your fee and slippage on every fill. Long-only spot. The last {oos}% of candles is held out and reported separately as out-of-sample.</p>
      {err && <p role="alert" className="mt-3 text-sm text-rose-neon">{err}</p>}

      {res && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="num text-[11px] text-mute">Run #{res.id} · {baseOf(res.symbol)}/USDT · {res.candlesUsed.toLocaleString()} closed candles · {time(m.startTime)} → {time(m.endTime)} · {res.source}</div>
          {res.warnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {res.warnings.map((w) => <li key={w} className="rounded border border-amber-neon/40 bg-amber-neon/10 px-3 py-1.5 text-xs text-amber-neon">{w}</li>)}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-ink-700 bg-ink-700 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ['Total return', pct(m.totalReturnPct), tone(m.totalReturnPct)],
              ['Buy & hold', pct(m.buyHoldReturnPct), tone(m.buyHoldReturnPct)],
              ['Win rate', m.winRatePct === null ? '—' : pct(m.winRatePct, 1, false), ''],
              ['Max drawdown', `-${fmt(m.maxDrawdownPct, 1)}%`, 'text-rose-neon'],
              ['Profit factor', PF(m.profitFactor), ''],
              ['Trades', m.trades, ''],
              ['Sharpe (ann.)', fmt(m.sharpe, 2), ''],
              ['Fees paid', usd(m.feesPaid), ''],
              ['Slippage paid', usd(m.slippagePaid), ''],
              ['Slippage rate', `${fmt(res.assumptions.slippageBps, 0)} bps`, ''],
            ].map(([k, v, c]) => (
              <div key={k} className="bg-ink-900 px-3 py-2"><div className="label">{k}</div><div className={`num text-base ${c}`}>{v}</div></div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="num w-full min-w-[520px] text-xs">
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Period</th><th className="font-normal">Return</th><th className="font-normal">Buy & hold</th><th className="font-normal">Trades</th><th className="font-normal">Win rate</th><th className="font-normal">Max DD</th><th className="font-normal">Profit factor</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {[['In-sample', res.inSample], ['Out-of-sample', res.outOfSample]].map(([k, s]) => (
                  <tr key={k}><td className="py-1.5 text-slate-300">{k}</td><td className={tone(s.totalReturnPct)}>{pct(s.totalReturnPct)}</td><td className={tone(s.buyHoldReturnPct)}>{pct(s.buyHoldReturnPct)}</td><td>{s.trades}</td><td>{s.winRatePct === null ? '—' : pct(s.winRatePct, 1, false)}</td><td>-{fmt(s.maxDrawdownPct, 1)}%</td><td>{PF(s.profitFactor)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <div className="label mb-1">Equity: <span className="text-cyan-neon">strategy</span> vs <span className="text-slate-400">buy &amp; hold</span>, starting $10,000</div>
            <LineChart series={series} height={220} />
          </div>

          <details className="rounded border border-ink-700">
            <summary className="cursor-pointer px-3 py-2 text-xs text-mute">Trade list ({res.trades.length})</summary>
            <div className="max-h-72 overflow-auto">
              <table className="num w-full min-w-[640px] text-xs">
                <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="px-3 py-1 font-normal">Entry</th><th className="font-normal">Entry price</th><th className="font-normal">Exit</th><th className="font-normal">Exit price</th><th className="font-normal">Fees</th><th className="font-normal">P&amp;L</th><th className="font-normal">Return</th></tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {res.trades.slice().reverse().map((t) => (
                    <tr key={t.entryTime}><td className="px-3 py-1">{time(t.entryTime)}</td><td>{price(t.entryPrice)}</td><td>{time(t.exitTime)}{t.closedAtEnd ? ' (end)' : ''}</td><td>{price(t.exitPrice)}</td><td>{usd(t.fees)}</td><td className={tone(t.pnl)}>{usd(t.pnl)}</td><td className={tone(t.returnPct)}>{pct(t.returnPct)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="text-[11px] text-mute">Backtest results are hypothetical. They use past prices and cannot account for every real-world cost or for how markets change. They are not real profits.</p>
        </div>
      )}
    </section>
  );
}
