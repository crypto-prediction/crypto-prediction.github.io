import { useCallback, useEffect, useRef, useState } from 'react';
import { api, useLive } from './lib.js';
import { baseOf, nameOf, setCoins } from './coins.js';
import { MarketCharts } from './components/Charts.jsx';
import { CoinSelector, UnavailableCoins, DataStatus, IndicatorCards } from './components/Market.jsx';
import { AnalysisPanel } from './components/Analysis.jsx';
import { BacktestPanel } from './components/Backtest.jsx';
import { PaperPanel } from './components/Paper.jsx';
import { FilamentTorus } from './components/FilamentTorus.jsx';
import { Insights } from './components/Insights.jsx';
import { useMarketSeries, useOverview } from './market.js';

const NO_SYMBOLS = [];
const OVERLAYS = [['ema20', 'EMA 20', 'text-cyan-neon'], ['ema50', 'EMA 50', 'text-violet-neon'], ['ema200', 'EMA 200', 'text-amber-neon'], ['bb', 'Bollinger', 'text-slate-300'], ['volume', 'Volume', 'text-slate-300']];

export default function App() {
  const [meta, setMeta] = useState(null);
  const [symbol, setSymbol] = useState(null);
  const [interval, setIntervalV] = useState('1h');
  const [data, setData] = useState(null);
  const [dataErr, setDataErr] = useState('');
  const [live, setLive] = useState(null);
  const [restTickers, setRestTickers] = useState({});
  const [overlays, setOverlays] = useState({ ema20: true, ema50: true, ema200: true, bb: true, volume: true });
  const [closedCount, setClosedCount] = useState(0);

  // The coin list comes from the server. Until it arrives there is nothing to show, so keep retrying.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = () => api('/api/meta').then((m) => {
      if (cancelled) return;
      setCoins(m.coins);
      setMeta(m);
      setSymbol((s) => s || m.symbols[0] || null);
      setDataErr('');
    }).catch((e) => {
      if (cancelled) return;
      setDataErr(e.message);
      timer = setTimeout(load, 5000);
    });
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const candleRequest = useRef(0);
  const loadCandles = useCallback(async () => {
    if (!symbol) return;
    const id = ++candleRequest.current;
    try {
      const d = await api(`/api/candles?symbol=${symbol}&interval=${interval}&limit=500`);
      if (id !== candleRequest.current) return; // switched coin while this was loading
      setData(d); setDataErr('');
    } catch (e) { if (id === candleRequest.current) setDataErr(`Market data for ${baseOf(symbol)} is unavailable: ${e.message}`); }
  }, [symbol, interval]);

  useEffect(() => { setData(null); setLive(null); loadCandles(); }, [loadCandles]);
  useEffect(() => { const t = setInterval(loadCandles, 60000); return () => clearInterval(t); }, [loadCandles]);

  // REST tickers as a fallback until the WebSocket delivers
  useEffect(() => {
    const f = () => api('/api/tickers').then((r) => setRestTickers(Object.fromEntries(r.tickers.map((t) => [t.symbol, t])))).catch(() => {});
    f(); const t = setInterval(f, 30000); return () => clearInterval(t);
  }, []);

  const onKline = useCallback((k) => {
    if (k.symbol !== symbol || k.interval !== interval) return;
    setLive(k);
    if (k.closed) { loadCandles(); setClosedCount((n) => n + 1); }
  }, [symbol, interval, loadCandles]);
  const { tickers, status, lastMsg } = useLive(symbol, interval, onKline);

  const livePrice = tickers[symbol]?.lastPrice ?? null;
  const symbols = meta?.symbols || NO_SYMBOLS;
  const market = useMarketSeries(symbols, interval);
  const overview = useOverview(Boolean(meta), interval);

  if (!meta || !symbol) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        {dataErr
          ? <p role="alert" className="max-w-md text-sm text-rose-neon">{dataErr} Retrying…</p>
          : <p role="status" className="text-sm text-mute">{meta ? 'Binance lists none of the configured coins right now.' : 'Loading the coin list…'}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-700 pb-3">
        <div>
          <h1 className="font-display text-xl font-bold tracking-wide">Signal<span className="text-cyan-neon">Lab</span> <span className="text-mute">/ crypto research</span></h1>
          <p className="text-xs text-mute">Real Binance market data · technical analysis · backtesting · paper trading</p>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Candle interval">
          {(meta?.intervals || ['1m', '5m', '15m', '1h', '4h', '1d']).map((i) => (
            <button key={i} className="seg num" aria-pressed={interval === i} onClick={() => setIntervalV(i)}>{i}</button>
          ))}
        </div>
      </header>

      <section className="h-[300px] overflow-hidden rounded-md border border-ink-700 sm:h-[460px]">
        <FilamentTorus series={market.series} interval={market.interval} error={market.error} tickers={tickers} overview={overview.coins} selected={symbol} onSelect={setSymbol} />
      </section>

      <UnavailableCoins coins={meta.coins} />
      <CoinSelector symbols={symbols} tickers={tickers} restTickers={restTickers} overview={overview} selected={symbol} onSelect={setSymbol} />
      <DataStatus stream={status} lastMsg={lastMsg} candlesAt={data?.fetchedAt} error={dataErr} source={meta?.source} />

      <Insights series={market.series} interval={market.interval} symbol={symbol} error={market.error} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="panel">
          <div className="panel-title">
            <span>{nameOf(symbol)} · {baseOf(symbol)}/USDT · {interval}</span>
            <div className="flex flex-wrap gap-1 font-normal normal-case tracking-normal">
              {OVERLAYS.map(([k, l, c]) => (
                <button key={k} className={`seg ${overlays[k] ? c : ''}`} aria-pressed={overlays[k]} onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}>{l}</button>
              ))}
            </div>
          </div>
          {data ? <MarketCharts data={data} live={live} overlays={overlays} /> : (
            <div className="flex h-[640px] items-center justify-center text-sm text-mute">{dataErr ? 'No chart: market data is unavailable.' : 'Loading Binance candles…'}</div>
          )}
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          <AnalysisPanel symbol={symbol} interval={interval} refreshKey={closedCount} />
          <IndicatorCards data={data} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_520px]">
        <BacktestPanel meta={meta} symbol={symbol} interval={interval} />
        <PaperPanel symbol={symbol} livePrice={livePrice} />
      </div>

      <footer className="border-t border-ink-700 pt-3 text-[11px] leading-relaxed text-mute">
        Market data: Binance spot public endpoints (REST and WebSocket). Signals and backtests are research tools, not financial advice. Paper trading is simulated and kept separate from any real account; no exchange keys are used.
      </footer>
    </div>
  );
}
