import { useState } from 'react';
import { compact, pct, price } from '../../format.js';
import { baseOf, nameOf } from '../../coins.js';
import { heatmapRows, HEATMAP_FILTERS } from '../../metrics.js';
import { Empty } from './common.jsx';

// strength follows the size of the 24h move; the printed number carries the exact value
const tint = (change) => {
  if (!Number.isFinite(change)) return undefined;
  const a = Math.min(0.5, 0.06 + (Math.abs(change) / 10) * 0.44);
  return change >= 0 ? `rgba(60,242,160,${a})` : `rgba(255,93,122,${a})`;
};

export default function Heatmap({ symbols, tickers, restTickers, overview, symbol, onSelect }) {
  const [filter, setFilter] = useState('all');
  const merged = { ...restTickers, ...tickers };
  const rows = heatmapRows(symbols, merged, overview.coins, filter);
  return (
    <section className="panel" data-heatmap>
      <div className="panel-title"><span>Live market heatmap</span><span className="font-normal normal-case tracking-normal text-mute">Colour shows the 24h change. Click a coin to select it.</span></div>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Filter coins">
        {HEATMAP_FILTERS.map(([k, label]) => <button key={k} type="button" data-filter={k} className="seg" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
      </div>
      {!rows.length ? <Empty>No coin matches this filter right now.</Empty> : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {rows.map((r) => (
            <button
              key={r.symbol}
              type="button"
              data-tile={r.symbol}
              aria-pressed={symbol === r.symbol}
              onClick={() => onSelect(r.symbol)}
              style={{ background: tint(r.change) }}
              className={`rounded border p-2.5 text-left ${symbol === r.symbol ? 'border-cyan-neon/70' : 'border-ink-700'}`}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-display text-sm font-bold text-slate-100">{baseOf(r.symbol)}</span>
                <span className="num text-sm text-slate-100">{pct(r.change)}</span>
              </div>
              <div className="truncate text-[10px] text-slate-300">{nameOf(r.symbol)}</div>
              <div className="num mt-1 text-sm text-slate-100">{r.price === null ? '—' : price(r.price)}</div>
              <div className="num text-[10px] text-slate-300">Vol ${compact(r.volume)}</div>
              <div className="num text-[10px] text-slate-300">Volatility {r.volatility === null ? '—' : `${r.volatility.toFixed(2)}%`}</div>
              <div className="text-[10px] text-slate-200">{r.trend ?? 'Loading…'}{r.signal ? ` · ${r.signal}` : ''}</div>
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-mute">Prices and 24h stats are live from Binance. Volatility, direction and signals come from closed candles at the selected interval.</p>
    </section>
  );
}
