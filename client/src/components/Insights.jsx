// Plain-language charts of the same real candles the torus draws. Only closed candles are counted.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { compact, pct, price } from '../format.js';
import { baseOf, pairColor } from '../coins.js';
import { median, topSlices } from '../metrics.js';

const SURFACE = '#0a0c10';
const GRID = '#1c222c';
const RISE = '#10A8A8';
const FALL = '#E0566F';
const RISE_SOFT = '#0B6F70';
const FALL_SOFT = '#8F3A4A';
const RECENT_BARS = 40;
const RECENT_FLOW = 24;

const name = baseOf;
const utcDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const utcTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const closed = (s) => s.candles.filter((c) => c.closed);
const change = (c) => ((c.close - c.open) / c.open) * 100;

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}

function useWidth(initial = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Card({ question, answer, note, children, className = '', testId }) {
  return (
    <section className={`panel flex flex-col ${className}`} data-insight={testId}>
      <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-mute">{question}</h3>
      <p className="mt-1 font-display text-sm font-semibold text-slate-100">{answer}</p>
      <div className="mt-3 min-w-0 flex-1">{children}</div>
      {note && <p className="mt-2 text-[11px] leading-relaxed text-mute">{note}</p>}
    </section>
  );
}

function Tip({ x, y, width, children }) {
  return (
    <div
      className="pointer-events-none absolute z-10 w-44 rounded border border-ink-600 bg-ink-950/95 p-2 text-[11px] leading-relaxed text-slate-300"
      style={{ left: Math.max(0, Math.min(x + 12, width - 176)), top: Math.max(0, y - 12) }}
    >
      {children}
    </div>
  );
}

function TableView({ caption, head, rows }) {
  return (
    <details className="mt-2 text-[11px] text-mute">
      <summary className="cursor-pointer select-none">View as table</summary>
      <div className="mt-1 max-h-48 overflow-auto">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{head.map((h, i) => <th key={h} scope="col" className={`py-0.5 font-medium ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody className="num text-slate-300">
            {rows.map((r) => <tr key={r[0]}>{r.map((v, i) => <td key={i} className={`py-0.5 ${i ? 'text-right' : ''}`}>{v}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Which pair did best: each pair's % change since the same starting candle, on one shared axis.
function PerformanceChart({ series, interval, symbol }) {
  const [ref, w] = useWidth(800);
  const [hover, setHover] = useState(null);
  const h = 250;
  const m = { t: 10, r: 92, b: 24, l: 46 };

  const data = useMemo(() => {
    const maps = series.map((s) => new Map(closed(s).map((c) => [c.openTime, c.close])));
    const times = closed(series[0]).map((c) => c.openTime).filter((t) => maps.every((mp) => mp.has(t)));
    if (times.length < 2) return null;
    const lines = series.map((s, i) => {
      const base = maps[i].get(times[0]);
      return { symbol: s.symbol, color: pairColor(s.symbol), values: times.map((t) => (maps[i].get(t) / base - 1) * 100) };
    });
    return { times, lines };
  }, [series]);

  if (!data) return <Card question="Which pair performed best?" answer="Not enough shared candles to compare." testId="performance" className="xl:col-span-2" />;

  const { times, lines } = data;
  const all = lines.flatMap((l) => l.values);
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = Math.min(ticks[0], ...all);
  const hi = Math.max(ticks[ticks.length - 1], ...all);
  const x = (i) => m.l + (i / (times.length - 1)) * (w - m.l - m.r);
  const y = (v) => m.t + ((hi - v) / (hi - lo || 1)) * (h - m.t - m.b);
  const last = times.length - 1;
  const ranked = [...lines].sort((a, b) => b.values[last] - a.values[last]);

  // with this many lines only the selected, best and worst are labelled; the legend and tooltip carry the rest
  const labelled = ranked.filter((l, i) => i === 0 || i === ranked.length - 1 || l.symbol === symbol);
  const labels = labelled.map((l) => ({ ...l, ly: y(l.values[last]) }));
  for (let i = 1; i < labels.length; i++) labels[i].ly = Math.max(labels[i].ly, labels[i - 1].ly + 15);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - m.l) / (w - m.l - m.r)) * last);
    setHover(i < 0 || i > last ? null : { i, px, py: e.clientY - rect.top });
  };
  const xTicks = Math.min(6, Math.floor((w - m.l - m.r) / 90));
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];

  return (
    <Card
      testId="performance"
      className="xl:col-span-2"
      question="Which pair performed best?"
      answer={best.values[last] < 0
        ? `All ${lines.length} fell. ${name(best.symbol)} fell least (${pct(best.values[last])}), ${name(worst.symbol)} fell most (${pct(worst.values[last])})`
        : `${name(best.symbol)} did best at ${pct(best.values[last])}; ${name(worst.symbol)} was last at ${pct(worst.values[last])}`}
      note={`Price change since ${utcDate(times[0])}, using ${times.length.toLocaleString('en-US')} closed ${interval} candles per pair. Every pair starts at 0% so they can be compared fairly. The selected pair is drawn brightest.`}
    >
      <ul className="mb-1 flex flex-wrap gap-3 text-[11px] text-slate-300">
        {lines.map((l) => <li key={l.symbol} className={`flex items-center gap-1.5 ${l.symbol === symbol ? 'font-semibold text-slate-100' : ''}`}><span className="h-0.5 w-3 rounded" style={{ background: l.color }} />{name(l.symbol)}</li>)}
      </ul>
      <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
        <svg width={w} height={h} role="img" aria-label={`Percent price change for each pair. ${ranked.map((l) => `${name(l.symbol)} ${pct(l.values[last])}`).join(', ')}.`} onPointerMove={onMove} onPointerDown={onMove} className="block touch-pan-y">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#2a3240' : GRID} strokeWidth="1" />
              <text x={m.l - 6} y={y(t) + 3} textAnchor="end" className="num fill-mute text-[10px]">{t > 0 ? '+' : ''}{t}%</text>
            </g>
          ))}
          {Array.from({ length: xTicks }, (_, k) => Math.round((k / Math.max(1, xTicks - 1)) * last)).map((i) => (
            <text key={i} x={x(i)} y={h - 6} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} className="fill-mute text-[10px]">{utcDate(times[i])}</text>
          ))}
          {[...lines].sort((a, b) => (a.symbol === symbol) - (b.symbol === symbol)).map((l) => (
            <polyline key={l.symbol} points={l.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={l.color} strokeWidth={l.symbol === symbol ? 2.5 : 1} opacity={l.symbol === symbol ? 1 : 0.55} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {labels.map((l) => (
            <text key={l.symbol} x={w - m.r + 8} y={l.ly + 3} className="num fill-slate-200 text-[11px]">{name(l.symbol)} {pct(l.values[last], 1)}</text>
          ))}
          {hover && (
            <g>
              <line x1={x(hover.i)} x2={x(hover.i)} y1={m.t} y2={h - m.b} stroke="#7d8798" strokeWidth="1" />
              {lines.map((l) => <circle key={l.symbol} cx={x(hover.i)} cy={y(l.values[hover.i])} r="4" fill={l.color} stroke={SURFACE} strokeWidth="2" />)}
            </g>
          )}
        </svg>
        {hover && (
          <Tip x={hover.px} y={hover.py} width={w}>
            <p className="text-mute">{utcTime(times[hover.i])}</p>
            {[...lines].sort((a, b) => b.values[hover.i] - a.values[hover.i]).map((l) => (
              <p key={l.symbol} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: l.color }} />{name(l.symbol)}</span>
                <span className="num font-semibold text-slate-100">{pct(l.values[hover.i])}</span>
              </p>
            ))}
          </Tip>
        )}
      </div>
      <TableView
        caption="Latest percent change per pair"
        head={['Pair', 'Start price', 'Latest close', 'Change']}
        rows={ranked.map((l) => {
          const c = closed(series.find((s) => s.symbol === l.symbol));
          return [`${name(l.symbol)}/USDT`, price(c[0].close), price(c[c.length - 1].close), pct(l.values[last])];
        })}
      />
    </Card>
  );
}

function arc(cx, cy, r0, r1, a0, a1) {
  // a full circle can't be drawn as one arc, so a lone 100% slice stops just short
  const end = a1 - a0 >= Math.PI * 2 ? a0 + Math.PI * 2 - 0.0001 : a1;
  const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = end - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, end)} L ${p(r0, end)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

// Pie with its figures printed beside it, so nothing depends on hovering or on colour alone.
export function Pie({ slices, center, centerLabel, valueLabel, caption }) {
  const [active, setActive] = useState(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const size = 150;
  const shown = slices.filter((s) => s.value > 0);
  let angle = 0;
  const arcs = shown.map((s) => {
    const a0 = angle;
    angle += (s.value / total) * Math.PI * 2;
    return { ...s, d: arc(size / 2, size / 2, 46, 72, a0, angle) };
  });
  return (
    <div className="flex flex-wrap items-center gap-4" onPointerLeave={() => setActive(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${caption}: ${shown.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(1)}%`).join(', ')}`} className="mx-auto shrink-0">
        {arcs.map((s) => (
          <path
            key={s.label}
            d={s.d}
            fill={s.color}
            stroke={SURFACE}
            strokeWidth="2"
            opacity={active && active !== s.label ? 0.35 : 1}
            onPointerEnter={() => setActive(s.label)}
            onPointerDown={() => setActive(s.label)}
          />
        ))}
        <text x={size / 2} y={size / 2 - 1} textAnchor="middle" className="num fill-slate-100 text-[14px] font-semibold">{center}</text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" className="fill-mute text-[10px]">{centerLabel}</text>
      </svg>
      <table className="min-w-[150px] flex-1 text-[11px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sr-only"><tr><th scope="col">Part</th><th scope="col">Share</th><th scope="col">{valueLabel}</th></tr></thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.label} className={active === s.label ? 'bg-ink-800' : ''} onPointerEnter={() => setActive(s.label)}>
              <td className="py-1 pr-2 text-slate-300"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: s.color }} />{s.label}</td>
              <td className="num py-1 pr-2 text-right font-semibold text-slate-100">{total ? ((s.value / total) * 100).toFixed(1) : '0.0'}%</td>
              <td className="num py-1 text-right text-mute">{s.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VolumeShare({ series, interval }) {
  const all = series.map((s) => {
    const value = closed(s).reduce((sum, c) => sum + c.quoteVolume, 0);
    return { label: name(s.symbol), value, color: pairColor(s.symbol), display: `$${compact(value)}` };
  });
  const total = all.reduce((s, x) => s + x.value, 0);
  const slices = topSlices(all, 5).map((s) => ({ ...s, display: s.display || `$${compact(s.value)}` }));
  const top = slices[0];
  const ranked = [...all].sort((a, b) => b.value - a.value);
  return (
    <Card
      testId="volume"
      question="Where did the trading money go?"
      answer={`${top.label} took ${total ? ((top.value / total) * 100).toFixed(1) : 0}% of the dollars traded`}
      note={`Total USDT traded across all ${all.length} pairs on Binance spot, over the same closed ${interval} candles.`}
    >
      <Pie slices={slices} center={`$${compact(total)}`} centerLabel="traded" valueLabel="USDT traded" caption="Share of USDT traded by pair" />
      <TableView
        caption="USDT traded by every pair"
        head={['Coin', 'Share', 'USDT traded']}
        rows={ranked.map((s) => [s.label, `${total ? ((s.value / total) * 100).toFixed(1) : '0.0'}%`, s.display])}
      />
    </Card>
  );
}

function CandleOutcomes({ s, interval }) {
  const candles = closed(s);
  const typical = median(candles.map((c) => Math.abs(change(c))));
  const groups = { bigUp: 0, smallUp: 0, smallDown: 0, bigDown: 0 };
  for (const c of candles) {
    const d = change(c);
    if (d >= 0) groups[d > typical ? 'bigUp' : 'smallUp']++;
    else groups[-d > typical ? 'bigDown' : 'smallDown']++;
  }
  const count = (n) => `${n.toLocaleString('en-US')}`;
  const slices = [
    { label: 'Large rise', value: groups.bigUp, color: RISE, display: count(groups.bigUp) },
    { label: 'Small rise', value: groups.smallUp, color: RISE_SOFT, display: count(groups.smallUp) },
    { label: 'Small fall', value: groups.smallDown, color: FALL_SOFT, display: count(groups.smallDown) },
    { label: 'Large fall', value: groups.bigDown, color: FALL, display: count(groups.bigDown) },
  ];
  const upShare = candles.length ? ((groups.bigUp + groups.smallUp) / candles.length) * 100 : 0;
  return (
    <Card
      testId="outcomes"
      question={`How did ${name(s.symbol)} candles end?`}
      answer={`${upShare.toFixed(1)}% of ${name(s.symbol)} candles closed flat or higher`}
      note={`"Large" means a move bigger than ${name(s.symbol)}'s median ${interval} candle, which is ${typical.toFixed(2)}%. Flat candles count as a small rise.`}
    >
      <Pie slices={slices} center={count(candles.length)} centerLabel="candles" valueLabel="Candles" caption={`${name(s.symbol)} candle outcomes`} />
    </Card>
  );
}

function roundedBar(x, y0, y1, w) {
  const r = Math.min(4, w / 2, Math.abs(y1 - y0));
  const up = y1 < y0;
  const sign = up ? 1 : -1;
  return `M ${x} ${y0} L ${x} ${y1 + sign * r} Q ${x} ${y1} ${x + r} ${y1} L ${x + w - r} ${y1} Q ${x + w} ${y1} ${x + w} ${y1 + sign * r} L ${x + w} ${y0} Z`;
}

function RecentMoves({ s, interval }) {
  const [ref, w] = useWidth(400);
  const [hover, setHover] = useState(null);
  const candles = closed(s).slice(-RECENT_BARS);
  const h = 170;
  const m = { t: 8, r: 4, b: 18, l: 38 };
  const moves = candles.map(change);
  const peak = Math.max(0.01, ...moves.map(Math.abs));
  const ticks = niceTicks(-peak, peak, 4);
  const top = Math.max(peak, ...ticks);
  const bottom = Math.min(-peak, ...ticks);
  const y = (v) => m.t + ((top - v) / (top - bottom)) * (h - m.t - m.b);
  const slot = (w - m.l - m.r) / Math.max(1, candles.length);
  const bw = Math.max(1, slot - 2);
  const ups = moves.filter((v) => v >= 0).length;
  return (
    <Card
      testId="moves"
      question={`How did the last ${candles.length} ${name(s.symbol)} candles move?`}
      answer={`${ups} closed flat or higher, ${candles.length - ups} closed lower`}
      note={`Each bar is one closed ${interval} candle, close versus open. Newest is on the right.`}
    >
      <div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
        <svg width={w} height={h} role="img" aria-label={`Percent change of the last ${candles.length} ${name(s.symbol)} candles`} className="block touch-pan-y">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#2a3240' : GRID} />
              <text x={m.l - 5} y={y(t) + 3} textAnchor="end" className="num fill-mute text-[10px]">{t > 0 ? '+' : ''}{Number(t.toFixed(2))}%</text>
            </g>
          ))}
          {candles.length > 0 && (
            <>
              <text x={m.l} y={h - 4} className="fill-mute text-[10px]">{utcDate(candles[0].openTime)}</text>
              <text x={w - m.r} y={h - 4} textAnchor="end" className="fill-mute text-[10px]">{utcDate(candles[candles.length - 1].openTime)}</text>
            </>
          )}
          {candles.map((c, i) => {
            const d = moves[i];
            const bx = m.l + i * slot + 1;
            return (
              <g key={c.openTime} opacity={hover && hover.i !== i ? 0.45 : 1}>
                {Math.abs(y(d) - y(0)) >= 0.5 && <path d={roundedBar(bx, y(0), y(d), bw)} fill={d >= 0 ? RISE : FALL} />}
                <rect
                  x={m.l + i * slot}
                  y={m.t}
                  width={slot}
                  height={h - m.t - m.b}
                  fill="transparent"
                  onPointerEnter={(e) => { const r = ref.current.getBoundingClientRect(); setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top }); }}
                  onPointerDown={(e) => { const r = ref.current.getBoundingClientRect(); setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top }); }}
                />
              </g>
            );
          })}
        </svg>
        {hover && candles[hover.i] && (
          <Tip x={hover.x} y={hover.y} width={w}>
            <p className="num font-semibold text-slate-100">{pct(moves[hover.i])}</p>
            <p className="text-mute">{utcTime(candles[hover.i].openTime)}</p>
            <p className="num">O {price(candles[hover.i].open)}</p>
            <p className="num">C {price(candles[hover.i].close)}</p>
          </Tip>
        )}
      </div>
      <TableView
        caption={`Last ${candles.length} ${name(s.symbol)} candles`}
        head={['Open time (UTC)', 'Open', 'Close', 'Change']}
        rows={[...candles].reverse().map((c) => [new Date(c.openTime).toISOString().slice(0, 16).replace('T', ' '), price(c.open), price(c.close), pct(change(c))])}
      />
    </Card>
  );
}

// Share of traded volume started by buyers (taker buys). A meter, since this is one ratio around 50%.
function BuyerMeter({ label, candles }) {
  const volume = candles.reduce((s, c) => s + c.volume, 0);
  const buys = candles.reduce((s, c) => s + c.takerBuyVolume, 0);
  const share = volume ? (buys / volume) * 100 : 50;
  return (
    <div data-buyers={share.toFixed(1)}>
      <div className="mb-1 flex items-baseline justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className="num text-mute"><span className="font-semibold text-slate-100">{share.toFixed(1)}%</span> buyers · {(100 - share).toFixed(1)}% sellers</span>
      </div>
      <div className="relative flex h-2.5 gap-0.5" role="img" aria-label={`${label}: buyers ${share.toFixed(1)} percent, sellers ${(100 - share).toFixed(1)} percent`}>
        <div className="rounded-l" style={{ width: `${share}%`, background: RISE }} />
        <div className="flex-1 rounded-r" style={{ background: FALL }} />
        <div className="absolute -bottom-1 -top-1 left-1/2 w-0.5 bg-slate-200" title="50%" />
      </div>
    </div>
  );
}

function BuyersSellers({ s, interval }) {
  const candles = closed(s);
  const recent = candles.slice(-RECENT_FLOW);
  const volume = recent.reduce((sum, c) => sum + c.volume, 0);
  const share = volume ? (recent.reduce((sum, c) => sum + c.takerBuyVolume, 0) / volume) * 100 : 50;
  const answer = Math.abs(share - 50) < 1 ? 'Recently close to balanced' : share > 50 ? 'Buyers have been pushing harder recently' : 'Sellers have been pushing harder recently';
  return (
    <Card
      testId="buyers"
      question={`Who pushed ${name(s.symbol)} harder?`}
      answer={answer}
      note={`Buyers are trades that took the asking price, sellers took the bid. The mark shows 50%. Within 1 point of it counts as balanced.`}
    >
      <div className="flex flex-col gap-5 pt-2">
        <BuyerMeter label={`Last ${recent.length} ${interval} candles`} candles={recent} />
        <BuyerMeter label={`All ${candles.length.toLocaleString('en-US')} candles`} candles={candles} />
      </div>
    </Card>
  );
}

export const Insights = memo(function Insights({ series, interval, symbol, error }) {
  const selected = series.find((s) => s.symbol === symbol);
  if (!series.length) {
    return (
      <section className="panel text-sm text-mute" role="status">
        {error ? 'No market data, so no charts are shown.' : 'Loading Binance candles…'}
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-[11px] font-bold uppercase tracking-[0.16em] text-slate-300">What the candles show</h2>
        <p className="text-[11px] text-mute">
          From the same Binance candles as the ring above. {selected ? `Lower row follows your selected pair (${name(symbol)}). ` : ''}Describes the past, not a forecast.
          {error && <span className="text-rose-neon"> {error}.</span>}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <PerformanceChart series={series} interval={interval} symbol={symbol} />
        <VolumeShare series={series} interval={interval} />
      </div>
      {selected && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <CandleOutcomes s={selected} interval={interval} />
          <RecentMoves s={selected} interval={interval} />
          <BuyersSellers s={selected} interval={interval} />
        </div>
      )}
    </div>
  );
});
