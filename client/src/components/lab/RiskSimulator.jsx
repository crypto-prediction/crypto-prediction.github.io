import { useCallback, useEffect, useState } from 'react';
import { api, fmt, price, usd } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { Stat, StatGrid, Empty } from './common.jsx';

const PRESETS = [
  ['BTC −5%', { shocks: { BTCUSDT: -5 }, correlated: true }],
  ['BTC −10%', { shocks: { BTCUSDT: -10 }, correlated: true }],
  ['BTC −20%', { shocks: { BTCUSDT: -20 }, correlated: true }],
  ['BTC −30%', { shocks: { BTCUSDT: -30 }, correlated: true }],
  ['ETH and SOL −25%', { shocks: { ETHUSDT: -25, SOLUSDT: -25 } }],
  ['Market crash −40%', { marketShockPct: -40 }],
  ['Volatility ×3', { volatilityMultiplier: 3 }],
  ['Thin liquidity', { liquidityFactor: 10 }],
  ['Fees and slippage up', { feePct: 0.5, slippageBps: 50 }],
];
const DEFAULTS = { shocks: {}, marketShockPct: 0, correlated: false, volatilityMultiplier: 1, feePct: 0.1, slippageBps: 5, liquidityFactor: 1, useCurrent: true };
const pp = (v, d = 2) => (v === null || v === undefined ? '—' : `${v.toFixed(d)}%`);

export default function RiskSimulator({ symbols }) {
  const [scenario, setScenario] = useState({ ...DEFAULTS, shocks: { BTCUSDT: -10 }, correlated: true });
  const [hypothetical, setHypothetical] = useState([]);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (s, h) => {
    setBusy(true);
    try {
      setResult(await api('/api/risk/simulate', { method: 'POST', body: { ...s, hypothetical: h.map((x) => ({ symbol: x.symbol, valueUsd: Number(x.valueUsd) })) } }));
      setErr('');
    } catch (x) { setErr(x.message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { run(scenario, hypothetical); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setScenario((s) => ({ ...s, [k]: e.target.value }));
  const setShock = (symbol, v) => setScenario((s) => ({ ...s, shocks: { ...s.shocks, [symbol]: v } }));
  const preset = (p) => {
    const next = { ...DEFAULTS, useCurrent: scenario.useCurrent, ...p };
    setScenario(next);
    run(next, hypothetical);
  };
  const r = result;

  return (
    <div className="flex flex-col gap-4" data-risk>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Risk simulator</span><span className="rounded border border-violet-neon/50 px-2 py-0.5 text-[10px] text-violet-neon">SCENARIOS ONLY · NEVER CHANGES YOUR ACCOUNT</span></div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Preset scenarios">
          {PRESETS.map(([label, p]) => <button key={label} type="button" data-preset={label} className="seg" onClick={() => preset(p)}>{label}</button>)}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); run(scenario, hypothetical); }} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <label className="flex flex-col gap-1"><span className="label">All coins move %</span><input id="risk-market" className="field num" type="number" step="any" min="-100" max="100" value={scenario.marketShockPct} onChange={set('marketShockPct')} /></label>
            <label className="flex flex-col gap-1"><span className="label">Volatility ×</span><input id="risk-vol" className="field num" type="number" step="any" min="0.1" max="10" value={scenario.volatilityMultiplier} onChange={set('volatilityMultiplier')} /></label>
            <label className="flex flex-col gap-1"><span className="label">Fee %</span><input id="risk-fee" className="field num" type="number" step="any" min="0" max="5" value={scenario.feePct} onChange={set('feePct')} /></label>
            <label className="flex flex-col gap-1"><span className="label">Slippage bps</span><input id="risk-slip" className="field num" type="number" step="any" min="0" max="1000" value={scenario.slippageBps} onChange={set('slippageBps')} /></label>
            <label className="flex flex-col gap-1"><span className="label">Thin liquidity ×</span><input id="risk-liq" className="field num" type="number" step="any" min="1" max="50" value={scenario.liquidityFactor} onChange={set('liquidityFactor')} /></label>
            <div className="flex flex-col justify-end gap-1 text-xs text-slate-300">
              <label className="flex items-center gap-2"><input type="checkbox" id="risk-correlated" checked={scenario.correlated} onChange={(e) => setScenario((s) => ({ ...s, correlated: e.target.checked }))} />Others follow BTC</label>
              <label className="flex items-center gap-2"><input type="checkbox" id="risk-current" checked={scenario.useCurrent} onChange={(e) => setScenario((s) => ({ ...s, useCurrent: e.target.checked }))} />Use my portfolio</label>
            </div>
          </div>
          <details open>
            <summary className="label cursor-pointer">Move per coin %</summary>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {symbols.map((s) => <label key={s} className="flex items-center gap-2 text-xs"><span className="w-10 text-mute">{baseOf(s)}</span><input aria-label={`${nameOf(s)} move percent`} data-shock={s} className="field num min-w-0 flex-1 py-1 text-xs" type="number" step="any" min="-100" max="100" value={scenario.shocks[s] ?? ''} onChange={(e) => setShock(s, e.target.value)} /></label>)}
            </div>
          </details>
          <div>
            <div className="mb-1 flex items-center gap-2"><span className="label">What-if positions</span><button type="button" data-add-hypothetical className="seg py-0" onClick={() => setHypothetical((h) => [...h, { symbol: symbols[0], valueUsd: 1000 }])}>Add</button></div>
            {hypothetical.map((h, i) => (
              <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-xs" data-hypothetical>
                <select aria-label="Coin" className="field py-1 text-xs" value={h.symbol} onChange={(e) => setHypothetical((list) => list.map((x, j) => (j === i ? { ...x, symbol: e.target.value } : x)))}>{symbols.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}</select>
                <input aria-label="Value in USD" className="field num w-28 py-1 text-xs" type="number" min="0" value={h.valueUsd} onChange={(e) => setHypothetical((list) => list.map((x, j) => (j === i ? { ...x, valueUsd: e.target.value } : x)))} />
                <button type="button" className="seg py-0" onClick={() => setHypothetical((list) => list.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
          </div>
          <div><button data-risk-run className="btn btn-cyan" disabled={busy}>{busy ? 'Working…' : 'Run scenario'}</button></div>
        </form>
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
      </section>

      {r && (
        <>
          <section className="panel flex flex-col gap-3" data-risk-results>
            <div className="panel-title"><span>Result</span><span className="font-normal normal-case tracking-normal text-amber-neon">{r.label}</span></div>
            {r.unpriced.length > 0 && <p className="text-sm text-amber-neon">No live price for {r.unpriced.map(baseOf).join(', ')}, so they're left out of this scenario.</p>}
            <StatGrid>
              <Stat label="Value before" value={usd(r.equityBefore)} note={`Cash ${usd(r.cash)}`} />
              <Stat label="Value after" value={usd(r.equityAfter)} />
              <Stat label="Potential loss" value={usd(r.totalImpactUsd)} note="Including exit costs" className={r.totalImpactUsd < 0 ? 'text-rose-neon' : ''} />
              <Stat label="Portfolio drawdown" value={pp(r.drawdownPct)} />
              <Stat label="Exit costs" value={usd(r.exitCostUsd)} note={`${fmt(r.assumptions.exitCostPct, 2)}% of value`} />
              <Stat label="Daily volatility" value={pp(r.dailyVolatilityPct)} />
            </StatGrid>
            <StatGrid>
              <Stat label="VaR 95%, 1 day" value={usd(r.var.var95Usd)} />
              <Stat label="CVaR 95%, 1 day" value={usd(r.var.cvar95Usd)} />
              <Stat label="VaR 99%, 1 day" value={usd(r.var.var99Usd)} />
              <Stat label="CVaR 99%, 1 day" value={usd(r.var.cvar99Usd)} />
              <Stat label="Largest position" value={pp(r.concentration.largestPct, 1)} note={`About ${fmt(r.concentration.effectivePositions, 1)} effective positions`} />
              <Stat label="Correlation exposure" value={r.weightedCorrelation === null ? '—' : fmt(r.weightedCorrelation, 2)} note="1 means they move together" />
            </StatGrid>
            <p className="text-[11px] text-mute">{r.var.basis}. VaR estimates the loss exceeded on about 5% or 1% of past days; CVaR is the average loss beyond that. {r.assumptions.note}</p>
          </section>
          <section className="panel" data-risk-positions>
            <div className="panel-title"><span>Position exposure</span></div>
            {!r.positions.length ? <Empty>Your paper account has no open positions. Add a what-if position above to test one.</Empty> : (
              <div className="overflow-x-auto">
                <table className="num w-full min-w-[760px] text-xs">
                  <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Value</th><th className="font-normal">Share</th><th className="font-normal">Beta to BTC</th><th className="font-normal">Move</th><th className="font-normal">Change</th><th className="font-normal">After</th><th className="font-normal">Support</th><th className="font-normal">Resistance</th><th className="font-normal">Reward / risk</th></tr></thead>
                  <tbody className="divide-y divide-ink-700">
                    {r.positions.map((p) => <tr key={p.symbol}><td className="py-1">{baseOf(p.symbol)}</td><td>{usd(p.value)}</td><td>{pp(p.shareOfEquityPct, 1)}</td><td>{p.beta === null ? '—' : fmt(p.beta, 2)}</td><td title={p.basis}>{pp(p.shockPct, 1)}</td><td className={p.moveUsd < 0 ? 'text-rose-neon' : ''}>{usd(p.moveUsd)}</td><td>{usd(p.valueAfter)}</td><td>{p.support === null ? '—' : price(p.support)}</td><td>{p.resistance === null ? '—' : price(p.resistance)}</td><td>{p.rewardRisk === null ? '—' : fmt(p.rewardRisk, 2)}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11px] text-mute">Reward / risk compares the distance up to the nearest swing high with the distance down to the nearest swing low on 1h candles.</p>
          </section>
        </>
      )}
    </div>
  );
}
