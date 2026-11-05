import { useMemo, useState } from 'react';
import { compact, fmt, price, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

const RANGES = ['24h', '7d', '30d'];

/** Price on the vertical axis, time across. Brighter cells mean more estimated positions at that price then. */
function Heatmap({ map, onHover }) {
  const W = 960, H = 420, labelW = 74;
  const rows = map.prices.length;
  const cols = map.times.length;
  const cw = (W - labelW) / cols;
  const ch = H / rows;
  const yOf = (p) => H - ((p - map.prices[0]) / (map.prices[rows - 1] - map.prices[0] || 1)) * (H - ch) - ch / 2;
  const cells = useMemo(() => {
    const out = [];
    const max = Math.sqrt(map.maxCell) || 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const l = map.long[r][c], s = map.short[r][c];
        if (l <= 0 && s <= 0) continue;
        const isLong = l >= s;
        out.push({ r, c, usd: isLong ? l : s, isLong, a: Math.min(0.95, 0.12 + (Math.sqrt(isLong ? l : s) / max) * 0.83) });
      }
    }
    return out;
  }, [map, rows, cols]);
  const pricePath = map.closes.map((v, c) => `${(labelW + c * cw + cw / 2).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const band = map.volatilityBand;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Estimated liquidation heatmap for ${nameOf(map.symbol)}`} data-liq-heatmap onMouseLeave={() => onHover(null)}>
      {cells.map((x) => (
        <rect
          key={`${x.r}-${x.c}`}
          data-cell
          x={labelW + x.c * cw}
          y={H - (x.r + 1) * ch}
          width={cw + 0.3}
          height={ch + 0.3}
          fill={x.isLong ? `rgba(255,193,94,${x.a})` : `rgba(34,225,255,${x.a})`}
          onMouseEnter={() => onHover({ price: map.prices[x.r], time: map.times[x.c], usd: x.usd, side: x.isLong ? 'Long' : 'Short' })}
        />
      ))}
      <polyline points={pricePath} fill="none" stroke="#dfe7f1" strokeWidth="1.5" />
      <rect x={labelW} width={W - labelW} y={yOf(band.high)} height={Math.max(1, yOf(band.low) - yOf(band.high))} fill="rgba(169,139,255,.06)" stroke="rgba(169,139,255,.35)" strokeDasharray="4 4" />
      {map.prices.filter((_, i) => i % 5 === 2).map((p) => <text key={p} x={labelW - 6} y={yOf(p) + 3} textAnchor="end" fill="#7d8798" fontSize="10" fontFamily="JetBrains Mono, monospace">{price(p)}</text>)}
    </svg>
  );
}

export default function Liquidations({ symbol, symbols, onSelect }) {
  const [range, setRange] = useState('7d');
  const [hours, setHours] = useState(24);
  const [hover, setHover] = useState(null);
  const map = useApi(`/api/liquidations/map?symbol=${symbol}&range=${range}`, { every: 120000 });
  const events = useApi(`/api/liquidations/events?symbol=${symbol}&hours=${hours}&limit=50`, { every: 30000 });
  const m = map.data;
  const e = events.data;
  return (
    <div className="flex flex-col gap-4" data-liquidations>
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Choose a coin">
        {symbols.map((s) => <button key={s} type="button" data-liq-coin={s} className="seg" aria-pressed={symbol === s} onClick={() => onSelect(s)}>{baseOf(s)}</button>)}
      </div>

      <section className="panel flex flex-col gap-3">
        <div className="panel-title">
          <span>{nameOf(symbol)} estimated liquidation zones</span>
          <span className="rounded border border-amber-neon/50 px-2 py-0.5 text-[10px] text-amber-neon" data-liq-estimate-badge>MODELLED ESTIMATE</span>
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time range">
          {RANGES.map((r) => <button key={r} type="button" data-liq-range={r} className="seg num" aria-pressed={range === r} onClick={() => setRange(r)}>{r}</button>)}
        </div>
        <Status {...map} what="the liquidation estimate" />
        {m && (
          <>
            <p data-liq-label className="text-xs text-amber-neon">{m.label}</p>
            <div className="relative">
              <Heatmap map={m} onHover={setHover} />
              {hover && <div className="pointer-events-none absolute right-2 top-2 rounded border border-ink-600 bg-ink-950/95 p-2 text-[11px] text-slate-300" data-liq-tip><p className="num">{time(hover.time)}</p><p className="num">{hover.side}s near {price(hover.price)}: about ${compact(hover.usd)}, estimated</p></div>}
            </div>
            <div className="flex flex-wrap gap-4 text-[11px] text-slate-300">
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ background: 'rgba(255,193,94,.9)' }} />Estimated long liquidations</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm" style={{ background: 'rgba(34,225,255,.9)' }} />Estimated short liquidations</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: '#dfe7f1' }} />Price</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm border border-dashed border-violet-neon" />Typical daily move, ±{fmt(m.volatilityBand.dailyMovePct, 2)}%</span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" data-liq-zones>
              {[['Largest estimated long zones below', m.longZones], ['Largest estimated short zones above', m.shortZones]].map(([label, zones]) => (
                <div key={label}>
                  <div className="label mb-1">{label}</div>
                  {!zones.length ? <Empty>None within the range shown.</Empty> : <ul className="num text-xs text-slate-300">{zones.map((z) => <li key={z.price} className="flex justify-between"><span>{price(z.price)}</span><span>about ${compact(z.usd)}</span></li>)}</ul>}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-mute">Model: each rise in open interest counts as new positions at that price, split by the long/short account ratio, at assumed leverage of {m.assumptions.leverage.map((l) => `${l.leverage}× (${Math.round(l.share * 100)}%)`).join(', ')}. A zone clears once price trades through it. {m.assumptions.covers}.</p>
          </>
        )}
      </section>

      <section className="panel flex flex-col gap-3" data-liq-events>
        <div className="panel-title"><span>Reported liquidation events</span><span className="rounded border border-lime-neon/50 px-2 py-0.5 text-[10px] text-lime-neon">REPORTED BY BINANCE</span></div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Hours to show">
          {[[1, '1h'], [24, '24h'], [168, '7d'], [720, '30d']].map(([h, label]) => <button key={h} type="button" className="seg num" aria-pressed={hours === h} onClick={() => setHours(h)}>{label}</button>)}
        </div>
        <Status {...events} what="liquidation events" />
        {e && (
          <>
            <StatGrid className="grid-cols-2 sm:grid-cols-4">
              <Stat label="Longs liquidated" value={`$${compact(e.totals.long?.usd ?? 0)}`} note={`${e.totals.long?.count ?? 0} events`} />
              <Stat label="Shorts liquidated" value={`$${compact(e.totals.short?.usd ?? 0)}`} note={`${e.totals.short?.count ?? 0} events`} />
              <Stat label="Feed" value={e.feed.status} note={e.feed.lastError || ''} />
              <Stat label="Collecting since" value={e.collectingSince ? time(new Date(e.collectingSince).getTime()) : 'No events yet'} />
            </StatGrid>
            <p className="text-[11px] text-mute">{e.label} History starts when this server began collecting, because Binance no longer offers past liquidations through its public API.</p>
            {!e.recent.length ? <Empty>No {baseOf(symbol)} liquidation has been reported in this period.</Empty> : (
              <div className="max-h-64 overflow-auto">
                <table className="num w-full text-xs">
                  <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="py-1 font-normal">Time</th><th className="font-normal">Position</th><th className="font-normal">Price</th><th className="font-normal">Size</th></tr></thead>
                  <tbody className="divide-y divide-ink-700">{e.recent.map((x, i) => <tr key={`${x.event_time}${i}`}><td className="py-1">{time(new Date(x.event_time).getTime())}</td><td className={x.side === 'long' ? 'text-rose-neon' : 'text-lime-neon'}>{x.side === 'long' ? 'Long liquidated' : 'Short liquidated'}</td><td>{price(x.price)}</td><td>${compact(x.usd)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
