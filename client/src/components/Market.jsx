import { fmt, fmtSig, pct, compact, price as fmtPrice, tone, ago, time, pricePrecision, useNow } from '../lib.js';
import { baseOf, nameOf, pairColor } from '../coins.js';

const price = fmtPrice;

const STALE_MS = 15000;

const SIGNAL_STYLE = { BUY: 'border-lime-neon/60 text-lime-neon', SELL: 'border-rose-neon/60 text-rose-neon', HOLD: 'border-amber-neon/60 text-amber-neon' };
const TREND_STYLE = { Uptrend: 'text-lime-neon', Downtrend: 'text-rose-neon' };

/** One card per coin. Picking a card switches the whole dashboard without a page refresh. */
export function CoinSelector({ symbols, tickers, restTickers, overview, selected, onSelect }) {
  const now = useNow(1000);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Choose a cryptocurrency">
      {symbols.map((s) => {
        const live = tickers[s];
        const t = live || restTickers?.[s];
        const stale = live ? now - live.receivedAt > STALE_MS : true;
        const o = overview.coins[s];
        const isSelected = selected === s;
        return (
          <button key={s} type="button" data-coin={s} onClick={() => onSelect(s)} aria-pressed={isSelected}
            className={`rounded-md border bg-ink-900/90 p-2.5 text-left transition-colors hover:border-ink-600 ${isSelected ? 'border-cyan-neon/60 shadow-glow' : 'border-ink-700'}`}>
            <div className="flex items-center justify-between gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: pairColor(s) }} />
                <span className="truncate font-display text-xs font-bold">{nameOf(s)}</span>
              </span>
              {live && !stale
                ? <span className="live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-lime-neon" title="Live" />
                : <span className="shrink-0 rounded bg-amber-neon/15 px-1 text-[9px] font-medium text-amber-neon">{t ? 'STALE' : 'NO DATA'}</span>}
            </div>
            <div className="text-[10px] text-mute">{baseOf(s)}/USDT</div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2">
              <span data-price className="num text-sm sm:text-base">{t ? price(t.lastPrice) : '—'}</span>
              <span className={`num text-[11px] ${tone(t?.priceChangePercent)}`}>{t ? pct(t.priceChangePercent) : '—'}</span>
            </div>
            <div className="num text-[10px] text-mute">24h vol {t ? `$${compact(t.quoteVolume)}` : '—'}</div>
            <div className="mt-1.5 flex items-center justify-between gap-1 border-t border-ink-700 pt-1.5 text-[10px]">
              <span className={TREND_STYLE[o?.trend] || 'text-mute'}>{o?.error ? 'No data' : o?.trend || (overview.loading ? 'Loading…' : '—')}</span>
              {o?.signal && <span data-signal className={`rounded border px-1 font-bold ${SIGNAL_STYLE[o.signal]}`}>{o.signal}</span>}
            </div>
            <div className="num flex justify-between gap-1 text-[10px] text-mute">
              <span>RSI {o?.rsi === null || o?.rsi === undefined ? '—' : o.rsi.toFixed(1)}</span>
              <span className={tone(o?.macdHistogram)}>MACD {fmtSig(o?.macdHistogram, 2)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Coins named in the coin list that Binance doesn't currently offer. */
export function UnavailableCoins({ coins }) {
  const off = (coins || []).filter((c) => !c.available);
  if (!off.length) return null;
  return (
    <div role="status" className="rounded border border-amber-neon/40 bg-amber-neon/10 px-3 py-2 text-xs text-amber-neon">
      Disabled: {off.map((c) => `${c.name} (${c.reason || 'unavailable'})`).join('; ')}.
    </div>
  );
}

export function DataStatus({ stream, lastMsg, candlesAt, error, source }) {
  const now = useNow(1000);
  const st = stream?.status || 'connecting';
  const ok = st === 'connected' && now - lastMsg < STALE_MS;
  const color = ok ? 'text-lime-neon' : st === 'connecting' || st === 'reconnecting' ? 'text-amber-neon' : 'text-rose-neon';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-mute">
        <span className={`num flex items-center gap-1.5 ${color}`}>
          <span className={`h-1.5 w-1.5 rounded-full bg-current ${ok ? 'live-dot' : ''}`} />
          {ok ? 'LIVE' : st === 'server-disconnected' ? 'SERVER OFFLINE' : st.toUpperCase()}
        </span>
        <span>Source: {source || 'Binance spot public market data'}</span>
        <span className="num">Last tick {ago(lastMsg, now)}</span>
        <span className="num">Candles fetched {candlesAt ? time(candlesAt) : '—'}</span>
        <span>Times shown in UTC on charts</span>
      </div>
      {error && <div role="alert" className="rounded border border-rose-neon/40 bg-rose-neon/10 px-3 py-2 text-sm text-rose-neon">{error}</div>}
      {!ok && stream?.lastError && st !== 'connecting' && (
        <div role="status" className="rounded border border-amber-neon/40 bg-amber-neon/10 px-3 py-2 text-sm text-amber-neon">
          Live prices are unavailable: {stream.lastError}. Prices shown may be out of date; paper orders use a fresh REST quote or are refused.
        </div>
      )}
    </div>
  );
}

const last = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null) return a[i]; return null; };

/** Values at the most recent CLOSED candle. */
export function IndicatorCards({ data }) {
  if (!data) return <div className="panel text-sm text-mute">Loading indicators…</div>;
  const n = data.candles.length;
  const closedIdx = data.candles[n - 1].closed ? n - 1 : n - 2;
  const at = (arr) => arr[closedIdx] ?? last(arr.slice(0, closedIdx + 1));
  const ind = data.indicators;
  const close = data.candles[closedIdx].close;
  const p = pricePrecision(close);
  const rsiV = at(ind.rsi14), h = at(ind.macd.histogram), hPrev = ind.macd.histogram[closedIdx - 1];
  const pb = at(ind.bb.percentB), up = at(ind.bb.upper), lo = at(ind.bb.lower);
  const rv = at(ind.volume.relative), bs = at(ind.volume.buyShare);
  const obvNow = ind.volume.obv[closedIdx], obvPrev = ind.volume.obv[Math.max(0, closedIdx - 20)];
  const rows = [
    ['RSI 14', fmt(rsiV, 1), rsiV >= 70 ? 'Overbought' : rsiV <= 30 ? 'Oversold' : 'Neutral', rsiV >= 70 ? -1 : rsiV <= 30 ? 1 : 0],
    ['MACD hist', fmtSig(h), `${h >= 0 ? 'Positive' : 'Negative'}, ${h > hPrev ? 'rising' : 'falling'}`, Math.sign(h)],
    ['EMA 20', fmt(at(ind.ema20), p), close > at(ind.ema20) ? 'Price above' : 'Price below', close > at(ind.ema20) ? 1 : -1],
    ['EMA 50', fmt(at(ind.ema50), p), close > at(ind.ema50) ? 'Price above' : 'Price below', close > at(ind.ema50) ? 1 : -1],
    ['EMA 200', at(ind.ema200) === null ? 'n/a' : fmt(at(ind.ema200), p), at(ind.ema200) === null ? 'Needs 200 bars' : close > at(ind.ema200) ? 'Price above' : 'Price below', at(ind.ema200) === null ? 0 : close > at(ind.ema200) ? 1 : -1],
    ['Bollinger %B', fmt(pb, 2), `Band ${fmt(lo, p)} – ${fmt(up, p)}`, pb > 1 ? -1 : pb < 0 ? 1 : 0],
    ['Rel. volume', rv === null ? '—' : `${fmt(rv, 2)}×`, rv >= 1.5 ? 'Heavy vs 20-bar avg' : rv <= 0.6 ? 'Light vs 20-bar avg' : 'Normal', 0],
    ['Volume', `$${compact(data.candles[closedIdx].quoteVolume)}`, `${fmtSig(data.candles[closedIdx].volume, 4)} ${baseOf(data.symbol)} this candle`, 0],
    ['Momentum (10)', pct(at(ind.momentum)), 'Change over 10 candles', Math.sign(at(ind.momentum) ?? 0)],
    ['Volatility (20)', `${fmt(at(ind.volatility), 2)}%`, 'Std dev of candle returns', 0],
    ['Trend', data.snapshot?.trend ?? '—', 'From EMA 50 and EMA 200', data.snapshot?.trend === 'Uptrend' ? 1 : data.snapshot?.trend === 'Downtrend' ? -1 : 0],
    ['Taker buy share', bs === null ? '—' : `${fmt(bs * 100, 1)}%`, `OBV ${obvNow >= obvPrev ? 'up' : 'down'} over 20 bars`, bs === null ? 0 : bs > 0.55 ? 1 : bs < 0.45 ? -1 : 0],
  ];
  return (
    <section className="panel">
      <div className="panel-title"><span>Indicators</span><span className="num font-normal normal-case tracking-normal text-mute">at last closed candle · {time(data.candles[closedIdx].closeTime + 1)}</span></div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-ink-700 bg-ink-700">
        {rows.map(([k, v, note, d]) => (
          <div key={k} className="bg-ink-900 px-3 py-2">
            <div className="label">{k}</div>
            <div className="num text-base">{v}</div>
            <div className={`text-[11px] ${d > 0 ? 'text-lime-neon' : d < 0 ? 'text-rose-neon' : 'text-mute'}`}>{note}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
