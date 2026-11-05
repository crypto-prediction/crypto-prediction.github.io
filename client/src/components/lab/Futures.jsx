import { compact, fmt, pct, price, time, tone } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

const Bars = ({ values, label }) => {
  const w = 720, h = 90;
  const max = Math.max(...values.map(Math.abs), 1e-12);
  const bw = w / values.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[90px] w-full" role="img" aria-label={label}>
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="#2a3240" />
      {values.map((v, i) => <rect key={i} x={i * bw + 0.5} width={Math.max(1, bw - 1)} y={v >= 0 ? h / 2 - (v / max) * (h / 2 - 2) : h / 2} height={(Math.abs(v) / max) * (h / 2 - 2)} fill={v >= 0 ? '#3cf2a0' : '#ff5d7a'} opacity="0.8" />)}
    </svg>
  );
};
const Line = ({ values, label, color = '#22e1ff' }) => {
  const w = 720, h = 90;
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-[90px] w-full" role="img" aria-label={label}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
};

const READING = { Conflict: 'text-amber-neon', 'Worth watching': 'text-amber-neon', 'Longs may be crowded': 'text-amber-neon', 'Shorts may be crowded': 'text-amber-neon', 'Unusually positive': 'text-amber-neon', 'Unusually negative': 'text-amber-neon' };

export default function Futures({ symbol, symbols, onSelect }) {
  const over = useApi('/api/futures/overview', { every: 120000 });
  const detail = useApi(`/api/futures/detail?symbol=${symbol}`, { every: 120000 });
  const d = detail.data;
  const c = d?.current;
  return (
    <div className="flex flex-col gap-4" data-futures>
      <div className="flex flex-wrap items-center gap-2 rounded border border-amber-neon/40 bg-amber-neon/5 px-3 py-2 text-xs text-amber-neon" data-futures-notice>
        Derivatives data from Binance perpetual futures. It's separate from spot: your signals and paper trading use only spot prices.
      </div>
      <section className="panel">
        <div className="panel-title"><span>All coins</span><span className="num font-normal normal-case tracking-normal text-mute">{over.data ? `${over.data.source} · ${time(over.data.fetchedAt)}` : ''}</span></div>
        <Status {...over} what="futures data" />
        {over.data && (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[860px] text-xs" data-futures-table>
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Mark price</th><th className="font-normal">Spot price</th><th className="font-normal">Futures vs spot</th><th className="font-normal">Funding / 8h</th><th className="font-normal">Annualised</th><th className="font-normal">Open interest</th><th className="font-normal">OI 24h</th><th className="font-normal">Long / short</th><th className="font-normal">Futures volume</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {over.data.coins.map((r) => (
                  <tr key={r.symbol} data-futures-row={r.symbol} onClick={() => onSelect(r.symbol)} className={`cursor-pointer hover:bg-ink-800 ${r.symbol === symbol ? 'bg-ink-800' : ''}`}>
                    <td className="py-1 font-semibold">{baseOf(r.symbol)}</td>
                    {r.unavailable ? <td colSpan={9} className="text-amber-neon">Unavailable: {r.unavailable}</td> : (
                      <>
                        <td>{price(r.markPrice)}</td>
                        <td>{r.spotPrice === null ? '—' : price(r.spotPrice)}</td>
                        <td className={tone(r.basisPct)}>{pct(r.basisPct, 3)}</td>
                        <td className={tone(r.fundingRatePct)}>{pct(r.fundingRatePct, 4)}</td>
                        <td className={tone(r.fundingAnnualizedPct)}>{pct(r.fundingAnnualizedPct, 1)}</td>
                        <td>${compact(r.openInterestUsd)}</td>
                        <td className={tone(r.oiChange24hPct)}>{pct(r.oiChange24hPct, 1)}</td>
                        <td>{r.longShortRatio === null ? '—' : fmt(r.longShortRatio, 2)}</td>
                        <td>${compact(r.futuresVolumeUsd)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap gap-1" role="group" aria-label="Choose a coin">
        {symbols.map((s) => <button key={s} type="button" className="seg" aria-pressed={symbol === s} onClick={() => onSelect(s)}>{baseOf(s)}</button>)}
      </div>
      <Status {...detail} what={`${baseOf(symbol)} futures data`} />
      {d && (
        <>
          <section className="panel flex flex-col gap-3" data-futures-analysis>
            <div className="panel-title"><span>{nameOf(symbol)} perpetual</span><span className="num font-normal normal-case tracking-normal text-mute">Next funding {time(c.nextFundingTime)} · spot trend {d.spotTrend ?? '—'}</span></div>
            <StatGrid>
              <Stat label="Mark" value={price(c.markPrice)} note={`Index ${price(c.indexPrice)}`} />
              <Stat label="Spot" value={c.spotPrice === null ? '—' : price(c.spotPrice)} note={`Difference ${pct(c.basisPct, 3)}`} />
              <Stat label="Funding / 8h" value={pct(c.fundingRatePct, 4)} className={tone(c.fundingRatePct)} />
              <Stat label="Open interest" value={`$${compact(c.openInterestUsd)}`} note={`${pct(c.oiChange24hPct, 1)} in 24h`} />
              <Stat label="Long accounts" value={c.longAccountPct === null ? '—' : pct(c.longAccountPct, 1, false)} note={`Ratio ${c.longShortRatio === null ? '—' : fmt(c.longShortRatio, 2)}`} />
              <Stat label="Futures volume" value={`$${compact(c.futuresVolumeUsd)}`} note={`${pct(c.futuresChange24hPct, 2)} in 24h`} />
            </StatGrid>
            <div>
              <div className="label mb-1">What the numbers show</div>
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.findings.map((f) => <li key={f.topic}><span className="font-semibold text-slate-100">{f.topic}: </span><span className={READING[f.reading] || 'text-slate-200'}>{f.reading}. </span><span className="text-slate-300">{f.text}</span></li>)}
              </ul>
              <p className="mt-1 text-[11px] text-mute">Rule-based readings of the figures above, not AI. They describe conditions and don't predict direction.</p>
            </div>
            {d.nearestEstimatedLiquidations && (
              <div data-liq-context>
                <div className="label mb-1">Nearest estimated liquidation zones</div>
                <p className="num text-xs text-slate-300">Longs below: {d.nearestEstimatedLiquidations.longZones.map((z) => `${price(z.price)} ($${compact(z.usd)})`).join(', ') || 'none in range'}</p>
                <p className="num text-xs text-slate-300">Shorts above: {d.nearestEstimatedLiquidations.shortZones.map((z) => `${price(z.price)} ($${compact(z.usd)})`).join(', ') || 'none in range'}</p>
                <p className="mt-1 text-[11px] text-amber-neon">{d.nearestEstimatedLiquidations.label}</p>
              </div>
            )}
          </section>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <section className="panel"><div className="panel-title"><span>Funding history</span></div>{d.fundingHistory.length ? <Bars values={d.fundingHistory.map((f) => f.fundingRatePct)} label="Funding rate history" /> : <Empty>No history.</Empty>}<p className="num mt-1 text-[11px] text-mute">Last {d.fundingHistory.length} payments, 8 hours apart. Green: longs pay.</p></section>
            <section className="panel"><div className="panel-title"><span>Open interest</span></div>{d.openInterestHistory.length ? <Line values={d.openInterestHistory.map((x) => x.usd)} label="Open interest over 7 days" /> : <Empty>No history.</Empty>}<p className="num mt-1 text-[11px] text-mute">Last 7 days, hourly, in USD.</p></section>
            <section className="panel"><div className="panel-title"><span>Long / short ratio</span></div>{d.longShortHistory.length ? <Line values={d.longShortHistory.map((x) => x.ratio)} label="Long short account ratio over 7 days" color="#a98bff" /> : <Empty>No history.</Empty>}<p className="num mt-1 text-[11px] text-mute">Last 7 days, by number of accounts rather than position size.</p></section>
          </div>
        </>
      )}
    </div>
  );
}
