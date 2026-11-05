import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { pricePrecision } from '../lib.js';

export const C = {
  bg: '#0a0c10', grid: '#141922', text: '#7d8798', border: '#1c222c',
  up: '#3cf2a0', down: '#ff5d7a', cyan: '#22e1ff', violet: '#a98bff', amber: '#ffc15e', white: '#dfe7f1',
};

const base = (height) => ({
  height,
  autoSize: true,
  layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.border },
  timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
  crosshair: { mode: CrosshairMode.Normal },
});

const t = (ms) => Math.floor(ms / 1000);
// Missing values become whitespace points so every pane has the same time points (keeps panes aligned).
const line = (candles, arr) => arr.map((v, i) => (v === null ? { time: t(candles[i].openTime) } : { time: t(candles[i].openTime), value: v }));

/** Price + EMA + Bollinger + volume, with RSI and MACD panes sharing the time axis. */
export function MarketCharts({ data, live, overlays }) {
  const mainEl = useRef(null), rsiEl = useRef(null), macdEl = useRef(null);
  const s = useRef({});

  useEffect(() => {
    const main = createChart(mainEl.current, base(380));
    const rsiC = createChart(rsiEl.current, base(110));
    const macdC = createChart(macdEl.current, base(120));
    const x = s.current;
    x.charts = [main, rsiC, macdC];
    x.candle = main.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down });
    x.vol = main.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const ln = (color, opts = {}) => main.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts });
    x.ema20 = ln(C.cyan); x.ema50 = ln(C.violet); x.ema200 = ln(C.amber, { lineWidth: 2 });
    x.bbU = ln('rgba(223,231,241,.35)', { lineStyle: LineStyle.Dashed, lineWidth: 1 });
    x.bbM = ln('rgba(223,231,241,.18)', { lineWidth: 1 });
    x.bbL = ln('rgba(223,231,241,.35)', { lineStyle: LineStyle.Dashed, lineWidth: 1 });
    x.rsi = rsiC.addLineSeries({ color: C.violet, lineWidth: 1.5, priceLineVisible: false });
    x.rsi.createPriceLine({ price: 70, color: 'rgba(255,93,122,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true });
    x.rsi.createPriceLine({ price: 30, color: 'rgba(60,242,160,.5)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true });
    x.hist = macdC.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    x.macd = macdC.addLineSeries({ color: C.cyan, lineWidth: 1.5, priceLineVisible: false });
    x.sig = macdC.addLineSeries({ color: C.amber, lineWidth: 1, priceLineVisible: false });
    // keep the three panes scrolled together
    let syncing = false;
    x.charts.forEach((ch) => ch.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      x.charts.forEach((o) => o !== ch && o.timeScale().setVisibleLogicalRange(r));
      syncing = false;
    }));
    return () => x.charts.forEach((ch) => ch.remove());
  }, []);

  useEffect(() => {
    const x = s.current;
    if (!data || !x.candle) return;
    const { candles, indicators: ind } = data;
    const prec = pricePrecision(candles[candles.length - 1]?.close || 1);
    const priceFormat = { type: 'price', precision: prec, minMove: 1 / 10 ** prec };
    x.candle.applyOptions({ priceFormat });
    [x.ema20, x.ema50, x.ema200, x.bbU, x.bbM, x.bbL].forEach((sr) => sr.applyOptions({ priceFormat }));
    // MACD values are tiny on cheap coins, so its pane gets more decimals
    const macdPeak = Math.max(1e-12, ...ind.macd.macd.filter((v) => v !== null).map(Math.abs));
    const macdPrec = Math.min(10, Math.max(2, 2 - Math.floor(Math.log10(macdPeak))));
    const macdFormat = { type: 'price', precision: macdPrec, minMove: 1 / 10 ** macdPrec };
    [x.hist, x.macd, x.sig].forEach((sr) => sr.applyOptions({ priceFormat: macdFormat }));
    x.candle.setData(candles.map((c) => ({ time: t(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close })));
    x.vol.setData(candles.map((c) => ({ time: t(c.openTime), value: c.volume, color: c.close >= c.open ? 'rgba(60,242,160,.28)' : 'rgba(255,93,122,.28)' })));
    x.ema20.setData(line(candles, ind.ema20));
    x.ema50.setData(line(candles, ind.ema50));
    x.ema200.setData(line(candles, ind.ema200));
    x.bbU.setData(line(candles, ind.bb.upper));
    x.bbM.setData(line(candles, ind.bb.middle));
    x.bbL.setData(line(candles, ind.bb.lower));
    x.rsi.setData(line(candles, ind.rsi14));
    x.macd.setData(line(candles, ind.macd.macd));
    x.sig.setData(line(candles, ind.macd.signal));
    x.hist.setData(ind.macd.histogram.map((v, i) => (v === null ? { time: t(candles[i].openTime) } : { time: t(candles[i].openTime), value: v, color: v >= 0 ? 'rgba(60,242,160,.6)' : 'rgba(255,93,122,.6)' })));
    x.charts[0].timeScale().fitContent();
  }, [data]);

  useEffect(() => {
    const x = s.current;
    if (!x.ema20) return;
    x.ema20.applyOptions({ visible: overlays.ema20 });
    x.ema50.applyOptions({ visible: overlays.ema50 });
    x.ema200.applyOptions({ visible: overlays.ema200 });
    [x.bbU, x.bbM, x.bbL].forEach((sr) => sr.applyOptions({ visible: overlays.bb }));
    x.vol.applyOptions({ visible: overlays.volume });
  }, [overlays]);

  // live candle updates from the WebSocket (only the candle and volume; indicators refresh on candle close)
  useEffect(() => {
    const x = s.current;
    if (!live || !x.candle || !data?.candles?.length) return;
    const last = data.candles[data.candles.length - 1];
    if (live.openTime < last.openTime) return;
    x.candle.update({ time: t(live.openTime), open: live.open, high: live.high, low: live.low, close: live.close });
    x.vol.update({ time: t(live.openTime), value: live.volume, color: live.close >= live.open ? 'rgba(60,242,160,.28)' : 'rgba(255,93,122,.28)' });
  }, [live, data]);

  return (
    <div className="flex flex-col gap-1">
      <div ref={mainEl} className="h-[380px] w-full" />
      <div className="label px-1 pt-1">RSI 14 <span className="text-violet-neon">●</span></div>
      <div ref={rsiEl} className="h-[110px] w-full" />
      <div className="label px-1 pt-1">MACD 12·26·9 <span className="text-cyan-neon">● macd</span> <span className="text-amber-neon">● signal</span></div>
      <div ref={macdEl} className="h-[120px] w-full" />
    </div>
  );
}

/** Simple line chart for equity curves. series: [{ data:[{time(ms),value}], color }] */
export function LineChart({ series, height = 200 }) {
  const el = useRef(null), ref = useRef({});
  useEffect(() => {
    const ch = createChart(el.current, { ...base(height), timeScale: { ...base(height).timeScale, timeVisible: true } });
    ref.current.ch = ch; ref.current.s = [];
    return () => ch.remove();
  }, [height]);
  useEffect(() => {
    const r = ref.current;
    if (!r.ch) return;
    r.s.forEach((x) => r.ch.removeSeries(x));
    r.s = series.map((sr) => {
      const x = r.ch.addLineSeries({ color: sr.color, lineWidth: sr.width || 1.5, priceLineVisible: false, lastValueVisible: true });
      // de-duplicate seconds (lightweight-charts needs strictly increasing time)
      const seen = new Set();
      x.setData(sr.data.map((p) => ({ time: Math.floor(p.time / 1000), value: p.value })).filter((p) => (seen.has(p.time) ? false : seen.add(p.time))));
      return x;
    });
    r.ch.timeScale().fitContent();
  }, [series]);
  return <div ref={el} style={{ height }} className="w-full" />;
}
