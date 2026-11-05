import { useMemo } from 'react';
import { pct, tone, usd } from '../../lib.js';
import { baseOf, pairColor } from '../../coins.js';
import { LineChart, C } from '../Charts.jsx';
import { Pie } from '../Insights.jsx';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

const CASH = '#5B6472';
const cellTint = (v) => (v === null ? undefined : v >= 0 ? `rgba(34,225,255,${Math.abs(v) * 0.45})` : `rgba(255,93,122,${Math.abs(v) * 0.45})`);
const pp = (v, d = 1) => (v === null || v === undefined ? '—' : `${v.toFixed(d)}%`);

export default function PortfolioIntel() {
  const { data: d, error, loading } = useApi('/api/portfolio/intel', { every: 30000 });
  const curve = useMemo(() => (d ? [{ data: d.equityCurve.map((e) => ({ time: new Date(e.ts).getTime(), value: e.equity })), color: C.violet, width: 2 }] : []), [d]);
  if (!d) return <section className="panel"><Status loading={loading} error={error} data={d} what="portfolio analysis" /></section>;
  const slices = d.risk.pricesLive ? [
    ...d.exposure.map((p) => ({ label: baseOf(p.symbol), value: p.marketValue, color: pairColor(p.symbol), display: usd(p.marketValue) })),
    { label: 'Cash', value: d.cash, color: CASH, display: usd(d.cash) },
  ] : null;
  const held = new Set(d.correlation.held);
  return (
    <div className="flex flex-col gap-4" data-portfolio>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Portfolio intelligence</span><span className="rounded border border-violet-neon/50 px-2 py-0.5 text-[10px] text-violet-neon">SIMULATED · READ ONLY</span></div>
        <Status loading={loading} error={error} data={d} what="portfolio analysis" />
        <StatGrid>
          <Stat label="Total value" value={d.totalValue === null ? 'needs live price' : usd(d.totalValue)} />
          <Stat label="Cash" value={usd(d.cash)} />
          <Stat label="Unrealised P&L" value={usd(d.unrealizedPnl)} className={tone(d.unrealizedPnl)} />
          <Stat label="Realised P&L" value={usd(d.realizedPnl)} className={tone(d.realizedPnl)} />
          <Stat label="Fees paid" value={usd(d.feesPaid)} />
          <Stat label="Positions" value={d.risk.positions} />
        </StatGrid>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="label mb-1">Allocation</div>
            {slices ? <Pie slices={slices} center={usd(d.totalValue, 0)} centerLabel="value" valueLabel="Value" caption="Portfolio allocation" /> : <p className="text-sm text-amber-neon">Waiting for a live price on every position.</p>}
          </div>
          <div>
            <div className="label mb-1">Risk exposure</div>
            <dl className="num grid grid-cols-[1fr_auto] gap-y-1 text-sm">
              <dt className="text-mute">Invested share of value</dt><dd>{pp(d.risk.investedPct)}</dd>
              <dt className="text-mute">Largest position</dt><dd>{pp(d.risk.largestPositionPct)}</dd>
              <dt className="text-mute">Daily volatility at current weights</dt><dd>{pp(d.risk.dailyVolatilityPct, 2)}</dd>
              <dt className="text-mute">Max drawdown since tracking began</dt><dd>{pp(d.risk.maxDrawdownPct, 2)}</dd>
            </dl>
            <p className="mt-1 text-[11px] text-mute">Volatility is measured from these coins' last 200 hourly returns. It describes the past and isn't a limit on future losses.</p>
          </div>
        </div>
        <div>
          <div className="label mb-1">Exposure by coin</div>
          {!d.exposure.length ? <Empty>No open positions.</Empty> : (
            <div className="overflow-x-auto">
              <table className="num w-full min-w-[480px] text-xs">
                <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Value</th><th className="font-normal">Share</th><th className="font-normal">Unrealised</th><th className="font-normal">Realised</th><th className="font-normal">Fees</th></tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {d.exposure.map((p) => <tr key={p.symbol}><td className="py-1">{baseOf(p.symbol)}</td><td>{usd(p.marketValue)}</td><td>{pct(p.sharePct, 1, false)}</td><td className={tone(p.unrealizedPnl)}>{usd(p.unrealizedPnl)}</td><td className={tone(p.realizedPnl)}>{usd(p.realizedPnl)}</td><td>{usd(p.feesPaid)}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title"><span>Historical performance</span><span className="num font-normal normal-case tracking-normal text-mute">{d.history.points} equity records</span></div>
        {d.equityCurve.length > 1 ? <LineChart series={curve} height={220} /> : <Empty>Not enough equity records yet.</Empty>}
      </section>
      <section className="panel">
        <div className="panel-title"><span>Correlation</span><span className="font-normal normal-case tracking-normal text-mute">{d.correlationBasis}. Coins you hold are marked ●.</span></div>
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[640px] text-center text-[11px]" data-correlation>
            <thead><tr><th />{d.correlation.symbols.map((s) => <th key={s} scope="col" className="py-1 font-normal text-mute">{baseOf(s)}</th>)}</tr></thead>
            <tbody>
              {d.correlation.symbols.map((a, i) => (
                <tr key={a}>
                  <th scope="row" className="pr-2 text-left font-normal text-mute">{held.has(a) ? '● ' : ''}{baseOf(a)}</th>
                  {d.correlation.matrix[i].map((v, j) => <td key={d.correlation.symbols[j]} className="px-1 py-1 text-slate-200" style={{ background: cellTint(v) }}>{v === null ? '—' : v.toFixed(2)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-mute">Near 1 means two coins have moved together, so holding both spreads risk less than it seems. Correlation changes over time.</p>
      </section>
    </div>
  );
}
