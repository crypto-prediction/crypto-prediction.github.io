// Rule-based research signal + historical evidence for that signal on the same data.
// The signal only reads indicator values at bar i (closed candles), never later bars.
import { computeAll } from './indicators.js';

const WEIGHTS = { trend: 0.3, crossover: 0.2, macd: 0.2, rsi: 0.15, bands: 0.1, volume: 0.05 };
export const BUY_AT = 0.35;
export const SELL_AT = -0.35;
export const MIN_BARS = 210; // EMA200 needs 200 bars, plus a margin

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));

export function signalAt(ind, candles, i) {
  const c = candles[i].close;
  const e20 = ind.ema20[i], e50 = ind.ema50[i], e200 = ind.ema200[i];
  const r = ind.rsi14[i];
  const h = ind.macd.histogram[i], hPrev = ind.macd.histogram[i - 1];
  const pb = ind.bb.percentB[i];
  const rv = ind.volume.relative[i];
  if ([e20, e50, e200, r, h, hPrev, pb].some((v) => v === null || v === undefined)) return null;

  const comps = [];
  // 1. Long-term trend: distance from EMA200, saturating at ±5%
  const d200 = c / e200 - 1;
  comps.push({ key: 'trend', name: 'Price vs EMA 200', value: d200 * 100, unit: '%', score: clamp(d200 / 0.05),
    reading: d200 >= 0 ? 'above long-term trend' : 'below long-term trend' });
  // 2. EMA 20/50 alignment
  const x = e20 / e50 - 1;
  comps.push({ key: 'crossover', name: 'EMA 20 vs EMA 50', value: x * 100, unit: '%', score: clamp(x / 0.02),
    reading: x >= 0 ? 'short-term trend up' : 'short-term trend down' });
  // 3. MACD histogram sign and direction, scaled by price
  const hs = h / c;
  const rising = h > hPrev;
  comps.push({ key: 'macd', name: 'MACD histogram', value: h, unit: '', score: clamp(hs / 0.002) * 0.7 + (rising ? 0.3 : -0.3),
    reading: `${h >= 0 ? 'positive' : 'negative'}, ${rising ? 'rising' : 'falling'}` });
  // 4. RSI: mean-reversion at extremes, mild momentum in the middle
  let rs;
  if (r >= 70) rs = -clamp((r - 70) / 15, 0, 1);
  else if (r <= 30) rs = clamp((30 - r) / 15, 0, 1);
  else rs = (r - 50) / 40;
  comps.push({ key: 'rsi', name: 'RSI 14', value: r, unit: '', score: rs,
    reading: r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : r >= 50 ? 'bullish range' : 'bearish range' });
  // 5. Bollinger %B: outside the bands leans toward reversion
  const bs = pb > 1 ? -clamp(pb - 1, 0, 1) * 0.6 - 0.4 : pb < 0 ? clamp(-pb, 0, 1) * 0.6 + 0.4 : (pb - 0.5) * 0.6;
  comps.push({ key: 'bands', name: 'Bollinger %B', value: pb, unit: '', score: clamp(bs),
    reading: pb > 1 ? 'above upper band' : pb < 0 ? 'below lower band' : pb >= 0.5 ? 'upper half of bands' : 'lower half of bands' });
  // 6. Volume confirms the direction of the current candle
  const dir = Math.sign(c - candles[i].open);
  const vs = rv === null ? 0 : clamp((rv - 1) / 1) * dir;
  comps.push({ key: 'volume', name: 'Relative volume', value: rv ?? 0, unit: '×', score: vs,
    reading: rv === null ? 'not enough data' : rv >= 1.5 ? `heavy, confirms ${dir >= 0 ? 'up' : 'down'} candle` : rv <= 0.6 ? 'light' : 'normal' });

  const score = comps.reduce((s, k) => s + WEIGHTS[k.key] * k.score, 0);
  const signal = score >= BUY_AT ? 'BUY' : score <= SELL_AT ? 'SELL' : 'HOLD';
  // Agreement: weighted share of indicators pointing the same way as the composite.
  const sign = Math.sign(score) || 1;
  const agreement = comps.reduce((s, k) => s + (Math.sign(k.score) === sign ? WEIGHTS[k.key] : 0), 0);
  return { signal, score, agreement, components: comps };
}

/** Market trend from the EMA stack: a description of the past candles, not a forecast. */
export function marketTrend(close, e50, e200) {
  if (e50 === null || e200 === null || e50 === undefined || e200 === undefined) return 'Not enough data';
  if (close > e50 && e50 > e200) return 'Uptrend';
  if (close < e50 && e50 < e200) return 'Downtrend';
  return 'Mixed';
}

/** One coin's indicator readings at bar i. */
export function marketSnapshot(candles, ind, i) {
  const c = candles[i];
  const h = ind.macd.histogram[i];
  const hPrev = ind.macd.histogram[i - 1];
  return {
    asOfCandleClose: c.closeTime,
    close: c.close,
    trend: marketTrend(c.close, ind.ema50[i], ind.ema200[i]),
    rsi: ind.rsi14[i],
    macd: ind.macd.macd[i],
    macdSignal: ind.macd.signal[i],
    macdHistogram: h,
    macdState: h === null ? null : `${h >= 0 ? 'Positive' : 'Negative'}, ${hPrev !== null && h > hPrev ? 'rising' : 'falling'}`,
    momentumPct: ind.momentum[i],
    volatilityPct: ind.volatility[i],
    volume: c.volume,
    quoteVolume: c.quoteVolume,
    relativeVolume: ind.volume.relative[i],
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

/**
 * For every past closed bar with the same signal as now, what happened over the next `horizon` bars?
 * Round-trip fees are subtracted so "profitable" means profitable after costs.
 */
export function historicalEvidence(candles, ind, signal, horizon = 12, roundTripCost = 0.003) {
  const fwd = [];
  const base = [];
  for (let i = MIN_BARS; i + horizon < candles.length; i++) {
    const r = candles[i + horizon].close / candles[i].close - 1;
    base.push(r);
    const s = signalAt(ind, candles, i);
    if (s && s.signal === signal) fwd.push(r);
  }
  const dirRet = (r) => (signal === 'SELL' ? -r : r); // SELL is judged by price falling
  const cost = signal === 'HOLD' ? 0 : roundTripCost;
  const wins = fwd.filter((r) => dirRet(r) - cost > 0).length;
  const sorted = [...fwd].sort((a, b) => a - b);
  const baseUp = base.filter((r) => r > 0).length;
  return {
    horizon,
    occurrences: fwd.length,
    hitRate: fwd.length ? wins / fwd.length : null,
    hitRateCI95: wilson(wins, fwd.length),
    meanForwardReturn: fwd.length ? fwd.reduce((a, b) => a + b, 0) / fwd.length : null,
    medianForwardReturn: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    baselineUpRate: base.length ? baseUp / base.length : null,
    baselineSamples: base.length,
    roundTripCost,
    note: signal === 'HOLD'
      ? 'HOLD is not a trade. Shown: how often price rose over the horizon after past HOLD readings.'
      : `Share of past ${signal} readings that would have been profitable after ${(roundTripCost * 100).toFixed(2)}% costs, ${horizon} bars later.`,
  };
}

export function analyze(candlesAll, { horizon = 12 } = {}) {
  const candles = candlesAll.filter((c) => c.closed !== false);
  if (candles.length < MIN_BARS + 2) {
    return { error: `Need at least ${MIN_BARS + 2} closed candles, got ${candles.length}` };
  }
  const ind = computeAll(candles);
  const i = candles.length - 1;
  const now = signalAt(ind, candles, i);
  const evidence = historicalEvidence(candles, ind, now.signal, horizon);
  return {
    asOfCandleClose: candles[i].closeTime,
    price: candles[i].close,
    barsAnalyzed: candles.length,
    ...now,
    market: marketSnapshot(candles, ind, i),
    confidence: Math.round(Math.abs(now.score) * 100),
    agreementPct: Math.round(now.agreement * 100),
    evidence,
    thresholds: { buy: BUY_AT, sell: SELL_AT },
    disclaimer: 'Confidence measures how strongly the indicators agree, not the chance of profit. Historical hit rate is a past frequency on this data, not a prediction.',
  };
}
