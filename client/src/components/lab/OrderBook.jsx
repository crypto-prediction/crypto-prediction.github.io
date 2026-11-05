import { useEffect, useMemo, useRef, useState } from 'react';
import { compact, fmt, price, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

/** Live top-of-book on its own socket, opened only while this tab is showing. */
function useLiveBook(symbol) {
  const [book, setBook] = useState(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    setBook(null);
    let stopped = false, retry = 0, timer, ws;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry = 0; setConnected(true); ws.send(JSON.stringify({ type: 'book', symbol })); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'book' && m.data.symbol === symbol) setBook(m.data);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, [symbol]);
  return { book, connected };
}

function DepthChart({ curve, mid }) {
  const w = 720, h = 200, pad = 6;
  const { bids, asks } = curve;
  const maxUsd = Math.max(bids.at(-1)?.usd ?? 0, asks.at(-1)?.usd ?? 0) || 1;
  const low = bids.at(-1)?.price ?? mid;
  const high = asks.at(-1)?.price ?? mid;
  const x = (p) => pad + ((p - low) / (high - low || 1)) * (w - pad * 2);
  const y = (u) => h - pad - (u / maxUsd) * (h - pad * 2);
  const steps = (rows) => rows.reduce((s, r, i) => `${s}${i ? ' ' : ''}${x(r.price).toFixed(1)},${y(r.usd).toFixed(1)}`, '');
  const area = (rows) => (rows.length ? `${x(rows[0].price).toFixed(1)},${h - pad} ${steps(rows)} ${x(rows.at(-1).price).toFixed(1)},${h - pad}` : '');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[200px] w-full" role="img" aria-label="Order book depth: cumulative bids and asks either side of the mid price" data-depth-chart>
      <polygon points={area(bids)} fill="rgba(60,242,160,.18)" stroke="#3cf2a0" strokeWidth="1.5" />
      <polygon points={area(asks)} fill="rgba(255,93,122,.18)" stroke="#ff5d7a" strokeWidth="1.5" />
      <line x1={x(mid)} x2={x(mid)} y1={pad} y2={h - pad} stroke="#7d8798" strokeDasharray="3 3" />
    </svg>
  );
}

function ImbalanceLine({ samples }) {
  const w = 720, h = 90;
  const points = useMemo(() => samples.map((s, i) => `${((i / Math.max(1, samples.length - 1)) * w).toFixed(1)},${(h / 2 - s.imbalance * (h / 2 - 4)).toFixed(1)}`).join(' '), [samples]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[90px] w-full" role="img" aria-label="Order book imbalance over time, from minus one to plus one">
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} stroke="#2a3240" />
      <polyline points={points} fill="none" stroke="#22e1ff" strokeWidth="1.5" />
    </svg>
  );
}

const Ladder = ({ rows, side }) => {
  const max = Math.max(...rows.map(([p, q]) => p * q), 1);
  return (
    <table className="num w-full text-[11px]">
      <tbody>
        {rows.slice(0, 12).map(([p, q]) => {
          const usd = Number(p) * Number(q);
          return (
            <tr key={p} style={{ background: `linear-gradient(to left, ${side === 'bid' ? 'rgba(60,242,160,.14)' : 'rgba(255,93,122,.14)'} ${(usd / max) * 100}%, transparent 0)` }}>
              <td className={`py-0.5 pl-1 ${side === 'bid' ? 'text-lime-neon' : 'text-rose-neon'}`}>{price(Number(p))}</td>
              <td className="pr-1 text-right text-slate-300">${compact(usd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const PRESSURE = (label) => (/buying/.test(label) ? 'text-lime-neon' : /selling/.test(label) ? 'text-rose-neon' : '');

export default function OrderBook({ symbol, symbols, onSelect }) {
  const { book, connected } = useLiveBook(symbol);
  const { data: d, error, loading } = useApi(`/api/orderbook?symbol=${symbol}`, { every: 15000 });
  const history = useApi(`/api/orderbook/history?symbol=${symbol}&hours=24`, { every: 300000 });
  const events = useRef([]);
  const [, bump] = useState(0);

  // keep what changed between snapshots, newest first
  useEffect(() => { events.current = []; bump((n) => n + 1); }, [symbol]);
  useEffect(() => {
    if (!d?.changes?.length) return;
    events.current = [...d.changes.map((c) => ({ ...c, at: d.time })), ...events.current].slice(0, 30);
    bump((n) => n + 1);
  }, [d]);

  return (
    <div className="flex flex-col gap-4" data-orderbook>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Choose a coin">
        {symbols.map((s) => <button key={s} type="button" data-book-coin={s} className="seg" aria-pressed={symbol === s} onClick={() => onSelect(s)}>{baseOf(s)}</button>)}
      </div>
      <Status loading={loading} error={error} data={d} what="the order book" />
      {d && (
        <section className="panel flex flex-col gap-3">
          <div className="panel-title">
            <span>{nameOf(symbol)} order book</span>
            <span className="num font-normal normal-case tracking-normal text-mute" data-book-source>{d.source} · snapshot {time(d.time)}</span>
          </div>
          <StatGrid>
            <Stat label="Best bid" value={price(d.bestBid)} />
            <Stat label="Best ask" value={price(d.bestAsk)} />
            <Stat label="Spread" value={`${fmt(d.spreadBps, 2)} bps`} />
            <Stat label="Bids within 0.5%" value={`$${compact(d.bands[1].bidUsd)}`} note={d.bands[1].complete ? '' : 'Book covers less than this'} />
            <Stat label="Asks within 0.5%" value={`$${compact(d.bands[1].askUsd)}`} note={d.bands[1].complete ? '' : 'Book covers less than this'} />
            <Stat label="Imbalance" value={fmt(d.pressure.imbalance, 2)} note="-1 asks to +1 bids" />
          </StatGrid>
          <p className="text-sm" data-pressure><span className={`font-semibold ${PRESSURE(d.pressure.label)}`}>{d.pressure.label}.</span> <span className="text-slate-300">{d.pressure.detail}</span></p>
          <DepthChart curve={d.curve} mid={d.mid} />
          <p className="num text-[11px] text-mute">This snapshot's 500 levels reach {fmt(d.coveredBidPct, 2)}% below and {fmt(d.coveredAskPct, 2)}% above the mid price. {d.caution}</p>
        </section>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="panel" data-live-book>
          <div className="panel-title"><span>Live top of book</span><span className={`num font-normal normal-case tracking-normal ${book ? 'text-lime-neon' : 'text-amber-neon'}`}>{book ? `WebSocket · ${time(book.time)}` : connected ? 'Waiting for data' : 'Connecting'}</span></div>
          {!book ? <Empty>Waiting for the live feed.</Empty> : (
            <div className="grid grid-cols-2 gap-2"><Ladder rows={book.bids} side="bid" /><Ladder rows={book.asks} side="ask" /></div>
          )}
        </section>
        <section className="panel" data-walls>
          <div className="panel-title"><span>Large visible orders</span></div>
          {d && !d.walls.bids.length && !d.walls.asks.length && <Empty>No level is 5× the typical size in this snapshot.</Empty>}
          {d && [['Bids', d.walls.bids, 'text-lime-neon'], ['Asks', d.walls.asks, 'text-rose-neon']].map(([label, rows, color]) => rows.length > 0 && (
            <div key={label} className="mb-2">
              <div className="label">{label}</div>
              <ul className="num text-xs">{rows.map((w) => <li key={w.price} className="flex justify-between"><span className={color}>{price(w.price)}</span><span className="text-slate-300">${compact(w.usd)}</span><span className="text-mute">{fmt(w.timesTypical, 0)}× typical</span></li>)}</ul>
            </div>
          ))}
          <p className="text-[11px] text-mute">Sizes as shown on the book right now. These aren't confirmed whale activity, and they may vanish without trading.</p>
        </section>
        <section className="panel" data-book-events>
          <div className="panel-title"><span>Changes while watching</span></div>
          {!events.current.length ? <Empty>Nothing notable yet. Checks every 15 seconds while this tab is open.</Empty> : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-auto text-xs">{events.current.map((e, i) => <li key={`${e.at}${i}`}><span className="num text-mute">{time(e.at)}</span> <span className="text-slate-300">{e.text}</span></li>)}</ul>
          )}
        </section>
      </div>
      <section className="panel" data-imbalance-history>
        <div className="panel-title"><span>Imbalance over 24 hours</span><span className="num font-normal normal-case tracking-normal text-mute">{history.data?.samples.length ?? 0} samples, within 0.5% of the price</span></div>
        {(history.data?.samples.length ?? 0) < 2 ? <Empty>History builds up from one sample every 5 minutes while the server runs.</Empty> : <ImbalanceLine samples={history.data.samples} />}
      </section>
    </div>
  );
}
