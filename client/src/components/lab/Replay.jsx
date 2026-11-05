import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { api, fmt, fmtSig, pct, price, pricePrecision, time, tone, usd } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { C } from '../Charts.jsx';
import { useApi, Stat, StatGrid, Empty } from './common.jsx';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const SPEEDS = [1, 2, 5, 10];
const TICK_MS = 800;
const t = (ms) => Math.floor(ms / 1000);
const utcInput = (ms) => new Date(ms).toISOString().slice(0, 16);

/** Candles, volume and EMAs. Only ever given what the server has already revealed. */
function ReplayChart({ session, markers }) {
  const el = useRef(null);
  const s = useRef({});

  useEffect(() => {
    const chart = createChart(el.current, {
      height: 380, autoSize: true,
      layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
    });
    const x = s.current;
    x.chart = chart;
    x.candle = chart.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down });
    x.vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = (color) => chart.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    x.ema20 = line(C.cyan);
    x.ema50 = line(C.violet);
    x.ema200 = line(C.amber);
    return () => chart.remove();
  }, []);

  useEffect(() => {
    const x = s.current;
    if (!session || !x.candle || !session.candles.length) return;
    const prec = pricePrecision(session.price);
    x.candle.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 1 / 10 ** prec } });
    const candle = (c) => ({ time: t(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close });
    const volume = (c) => ({ time: t(c.openTime), value: c.volume, color: c.close >= c.open ? 'rgba(60,242,160,.28)' : 'rgba(255,93,122,.28)' });
    const point = (c, v) => (v === null || v === undefined ? { time: t(c.openTime) } : { time: t(c.openTime), value: v });
    if (session.replacesChart) {
      x.candle.setData(session.candles.map(candle));
      x.vol.setData(session.candles.map(volume));
      for (const k of ['ema20', 'ema50', 'ema200']) x[k].setData(session.candles.map((c, i) => point(c, session.overlays[k][i])));
      x.chart.timeScale().scrollToRealTime();
    } else {
      session.candles.forEach((c, i) => {
        x.candle.update(candle(c));
        x.vol.update(volume(c));
        for (const k of ['ema20', 'ema50', 'ema200']) {
          const v = session.overlays[k][i];
          if (v !== null && v !== undefined) x[k].update(point(c, v));
        }
      });
    }
  }, [session]);

  useEffect(() => {
    const x = s.current;
    if (!x.candle) return;
    x.candle.setMarkers([...markers].sort((a, b) => a.time - b.time).map((m) => ({
      time: t(m.time),
      position: m.kind === 'entry' ? 'belowBar' : 'aboveBar',
      color: m.kind === 'entry' ? C.up : C.down,
      shape: m.kind === 'entry' ? 'arrowUp' : 'arrowDown',
    })));
  }, [markers]);

  return <div ref={el} className="h-[380px] w-full" data-replay-chart />;
}

function StartForm({ symbols, symbol, onStart, onResume }) {
  const strategies = useApi('/api/strategies');
  const recent = useApi('/api/replay/sessions?limit=5');
  const [form, setForm] = useState({ symbol, interval: '1h', start: utcInput(Date.now() - 30 * 86400e3), cash: 10000, strategyId: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function start(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api('/api/replay/sessions', { method: 'POST', body: { symbol: form.symbol, interval: form.interval, start: Date.parse(`${form.start}:00Z`), cash: Number(form.cash), strategyId: form.strategyId || undefined } });
      onStart(r);
    } catch (x) { setErr(x.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel flex flex-col gap-3" data-replay-start>
      <div className="panel-title"><span>Market replay</span><span className="font-normal normal-case tracking-normal text-mute">Real Binance candles, revealed one at a time</span></div>
      <form onSubmit={start} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="flex flex-col gap-1"><span className="label">Coin</span><select id="replay-symbol" className="field" value={form.symbol} onChange={set('symbol')}>{symbols.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="label">Interval</span><select id="replay-interval" className="field num" value={form.interval} onChange={set('interval')}>{INTERVALS.map((i) => <option key={i}>{i}</option>)}</select></label>
        <label className="col-span-2 flex flex-col gap-1"><span className="label">Start (UTC)</span><input id="replay-start" className="field num" type="datetime-local" required value={form.start} onChange={set('start')} /></label>
        <label className="flex flex-col gap-1"><span className="label">Simulated cash</span><input id="replay-cash" className="field num" type="number" min="100" value={form.cash} onChange={set('cash')} /></label>
        <label className="flex flex-col gap-1"><span className="label">Strategy (optional)</span><select id="replay-strategy" className="field" value={form.strategyId} onChange={set('strategyId')}><option value="">None</option>{strategies.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <div className="col-span-2 flex items-end sm:col-span-3 lg:col-span-6"><button className="btn btn-cyan" disabled={busy}>{busy ? 'Loading candles…' : 'Start replay'}</button></div>
      </form>
      {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
      <p className="text-[11px] text-mute">The server holds the candles and sends only those up to the current point, so future prices never reach this page. Simulated orders stay in the replay and don't affect your paper account.</p>
      {recent.data?.length > 0 && (
        <div>
          <div className="label mb-1">Recent replays</div>
          <ul className="flex flex-wrap gap-1">
            {recent.data.map((r) => <li key={r.id}><button type="button" className="seg" onClick={() => onResume(r.id)}>{baseOf(r.symbol)} {r.interval} from {new Date(r.start_time).toISOString().slice(0, 10)}</button></li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function Replay({ symbols, symbol }) {
  const [session, setSession] = useState(null);
  const [markers, setMarkers] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [amount, setAmount] = useState(1000);
  const [err, setErr] = useState('');
  const busy = useRef(false);

  const apply = useCallback((view) => {
    setSession(view);
    if (view.strategy) setMarkers((m) => (view.replacesChart ? view.strategy.markers : [...m, ...view.strategy.markers]));
    else setMarkers([]);
    setErr('');
  }, []);

  const step = useCallback(async (count) => {
    if (!session || busy.current) return;
    busy.current = true;
    try {
      const view = await api(`/api/replay/sessions/${session.id}/step`, { method: 'POST', body: { count } });
      apply(view);
      if (!view.hasMore && count > 0) setPlaying(false);
    } catch (x) {
      setErr(x.message);
      setPlaying(false);
    } finally {
      busy.current = false;
    }
  }, [session, apply]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => step(speed), TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, step]);

  async function order(side, closeAll = false) {
    setPlaying(false);
    try {
      apply(await api(`/api/replay/sessions/${session.id}/order`, { method: 'POST', body: { side, amountUsd: Number(amount), closeAll } }));
    } catch (x) { setErr(x.message); }
  }
  async function resume(id) {
    try { apply(await api(`/api/replay/sessions/${id}`)); } catch (x) { setErr(x.message); }
  }

  if (!session) {
    return (
      <>
        <StartForm symbols={symbols} symbol={symbol} onStart={apply} onResume={resume} />
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
      </>
    );
  }

  const i = session.indicators;
  const p = session.portfolio;
  const sig = session.strategy?.signal;
  return (
    <div className="flex flex-col gap-4" data-replay>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title">
          <span>{nameOf(session.symbol)} · {session.interval} replay</span>
          <span className="num font-normal normal-case tracking-normal text-mute" data-replay-asof>As of {new Date(session.asOf).toISOString().slice(0, 16).replace('T', ' ')} UTC · candle {session.position + 1}</span>
        </div>
        <ReplayChart session={session} markers={markers} />
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" data-replay-back10 className="seg num" onClick={() => step(-10)}>−10</button>
          <button type="button" data-replay-back className="seg num" onClick={() => step(-1)}>−1</button>
          <button type="button" data-replay-play className="btn btn-cyan py-1" disabled={!session.hasMore} onClick={() => setPlaying((v) => !v)}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" data-replay-next className="seg num" disabled={!session.hasMore} onClick={() => step(1)}>+1</button>
          <button type="button" data-replay-next10 className="seg num" disabled={!session.hasMore} onClick={() => step(10)}>+10</button>
          <span className="label ml-3">Speed</span>
          {SPEEDS.map((n) => <button key={n} type="button" className="seg num" aria-pressed={speed === n} onClick={() => setSpeed(n)}>{n}×</button>)}
          <button type="button" className="btn btn-ghost ml-auto py-1" onClick={() => { setPlaying(false); setSession(null); setMarkers([]); }}>New replay</button>
        </div>
        {!session.hasMore && <p className="text-xs text-amber-neon">You've reached the latest closed candle.</p>}
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
        <StatGrid className="grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat label="Close" value={price(session.price)} />
          <Stat label="Volume" value={fmtSig(i.volume, 4)} />
          <Stat label="RSI 14" value={i.rsi === null ? '—' : fmt(i.rsi, 1)} />
          <Stat label="MACD hist" value={fmtSig(i.macdHistogram)} className={tone(i.macdHistogram)} />
          <Stat label="EMA 20" value={i.ema20 === null ? '—' : price(i.ema20)} />
          <Stat label="EMA 50" value={i.ema50 === null ? '—' : price(i.ema50)} />
          <Stat label="EMA 200" value={i.ema200 === null ? '—' : price(i.ema200)} />
          <Stat label="Trend" value={i.trend} />
        </StatGrid>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="panel flex flex-col gap-3" data-replay-portfolio>
          <div className="panel-title"><span>Simulated portfolio</span><span className="rounded border border-violet-neon/50 px-2 py-0.5 text-[10px] text-violet-neon">REPLAY ONLY</span></div>
          <StatGrid className="grid-cols-2 sm:grid-cols-3">
            <Stat label="Equity" value={usd(p.equity)} />
            <Stat label="Return" value={pct(p.returnPct)} className={tone(p.returnPct)} note={`Buy & hold ${pct(session.buyHoldReturnPct)}`} />
            <Stat label="Cash" value={usd(p.cash)} />
            <Stat label="Unrealised" value={usd(p.unrealizedPnl)} className={tone(p.unrealizedPnl)} />
            <Stat label="Realised" value={usd(p.realizedPnl)} className={tone(p.realizedPnl)} />
            <Stat label="Fees" value={usd(p.feesPaid)} />
          </StatGrid>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2"><span className="label">USD</span><input id="replay-amount" className="field num w-28" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button type="button" data-replay-buy className="btn btn-lime" onClick={() => order('BUY')}>Buy</button>
            <button type="button" data-replay-sell className="btn btn-rose" disabled={p.qty <= 0} onClick={() => order('SELL')}>Sell</button>
            <button type="button" data-replay-close className="btn btn-ghost" disabled={p.qty <= 0} onClick={() => order('SELL', true)}>Close position</button>
          </div>
          <p className="text-[11px] text-mute">Orders fill at this candle's close with the same fee and slippage as paper trading. Stepping back undoes anything done after that point.</p>
          {!session.trades.length ? <Empty>No simulated trades yet.</Empty> : (
            <div className="max-h-44 overflow-auto">
              <table className="num w-full text-xs">
                <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="py-1 font-normal">Candle</th><th className="font-normal">Side</th><th className="font-normal">Qty</th><th className="font-normal">Price</th><th className="font-normal">Fee</th></tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {session.trades.map((x) => <tr key={x.id}><td className="py-1">{time(new Date(x.candle_time).getTime())}</td><td className={x.side === 'BUY' ? 'text-lime-neon' : 'text-rose-neon'}>{x.side}</td><td>{fmt(x.qty, 6)}</td><td>{price(x.price)}</td><td>{usd(x.fee)}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel flex flex-col gap-2" data-replay-strategy>
          <div className="panel-title"><span>Strategy at this candle</span></div>
          {!session.strategy ? <Empty>No strategy chosen for this replay. Build one in the Strategy builder, then start a new replay with it.</Empty> : (
            <>
              <p className="text-sm"><span className="font-semibold text-slate-100">{session.strategy.name}</span>: <span className={sig.action === 'enter' ? 'text-lime-neon' : sig.action === 'exit' ? 'text-rose-neon' : 'text-mute'}>{sig.action === 'enter' ? 'entry conditions met' : sig.action === 'exit' ? 'exit conditions met' : 'no action'}</span></p>
              {[['Entry', sig.entry], ['Exit', sig.exit]].map(([label, group]) => (
                <div key={label}>
                  <div className="label">{label}</div>
                  <ul className="text-xs">{group.results.map((r) => <li key={r.text} className="flex justify-between gap-2"><span className="text-slate-300">{r.text}</span><span className={r.met ? 'text-lime-neon' : 'text-mute'}>{r.met === null ? 'not enough data' : r.met ? 'yes' : 'no'}</span></li>)}</ul>
                </div>
              ))}
              <p className="text-[11px] text-mute">Arrows on the chart mark past candles where its conditions were met. The strategy only reports here: you decide whether to trade.</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
