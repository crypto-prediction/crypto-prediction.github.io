// Indicator correctness: published reference values + independent naive implementations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, volumeAnalysis } from '../src/indicators.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);

// StockCharts' published RSI worked example (Wilder smoothing)
const SC = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];

test('RSI(14) matches the StockCharts worked example', () => {
  // The published sheet rounds its intermediate averages, so its values sit ~0.07 above exact math.
  const r = rsi(SC, 14);
  assert.equal(r[13], null);
  [70.53, 66.32, 66.55, 69.41, 66.36, 57.97].forEach((v, k) => close(r[14 + k], v, 0.1, `RSI #${k + 1}`));
});

test('RSI equals an independent Wilder implementation exactly', () => {
  const ch = SC.slice(1).map((c, i) => c - SC[i]);
  let ag = ch.slice(0, 14).filter((d) => d > 0).reduce((a, b) => a + b, 0) / 14;
  let al = -ch.slice(0, 14).filter((d) => d < 0).reduce((a, b) => a + b, 0) / 14;
  const r = rsi(SC, 14);
  close(r[14], 100 - 100 / (1 + ag / al), 1e-12, 'seed');
  for (let i = 14; i < ch.length; i++) {
    ag = (ag * 13 + Math.max(ch[i], 0)) / 14; al = (al * 13 + Math.max(-ch[i], 0)) / 14;
    close(r[i + 1], 100 - 100 / (1 + ag / al), 1e-12, `rsi[${i + 1}]`);
  }
});

test('RSI is 100 on a straight rise and 0 on a straight fall', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up)[29], 100);
  assert.equal(rsi(up.slice().reverse())[29], 0);
});

// deterministic test series (NOT market data): a sine wave plus drift
const series = Array.from({ length: 400 }, (_, i) => 100 + i * 0.05 + 8 * Math.sin(i / 7) + 3 * Math.cos(i / 3.3));

test('SMA matches a naive window average', () => {
  const s = sma(series, 20);
  for (let i = 19; i < series.length; i += 37) {
    const naive = series.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
    close(s[i], naive, 1e-9, `sma[${i}]`);
  }
  assert.equal(s[18], null);
});

test('EMA is SMA-seeded and follows the recursive definition', () => {
  for (const n of [20, 50, 200]) {
    const e = ema(series, n);
    assert.equal(e[n - 2], null);
    const seed = series.slice(0, n).reduce((a, b) => a + b, 0) / n;
    close(e[n - 1], seed, 1e-9, `seed ema${n}`);
    let prev = seed; const k = 2 / (n + 1);
    for (let i = n; i < series.length; i++) prev = series[i] * k + prev * (1 - k);
    close(e[series.length - 1], prev, 1e-9, `last ema${n}`);
  }
});

test('MACD(12,26,9) = EMA12 − EMA26, signal = EMA9 of MACD, histogram = difference', () => {
  const m = macd(series);
  const e12 = ema(series, 12), e26 = ema(series, 26);
  assert.equal(m.macd[24], null);
  close(m.macd[25], e12[25] - e26[25], 1e-12, 'first macd');
  // signal seeds at the 9th MACD value (index 25 + 8)
  assert.equal(m.signal[32], null);
  const first9 = m.macd.slice(25, 34);
  close(m.signal[33], first9.reduce((a, b) => a + b, 0) / 9, 1e-12, 'signal seed');
  for (let i = 40; i < series.length; i += 53) close(m.histogram[i], m.macd[i] - m.signal[i], 1e-12, `hist[${i}]`);
});

test('Bollinger(20,2) uses population standard deviation', () => {
  const b = bollinger(series, 20, 2);
  for (let i = 19; i < series.length; i += 41) {
    const w = series.slice(i - 19, i + 1);
    const mu = w.reduce((a, c) => a + c, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, c) => a + (c - mu) ** 2, 0) / 20);
    close(b.middle[i], mu, 1e-9, 'mid');
    close(b.upper[i], mu + 2 * sd, 1e-9, 'upper');
    close(b.lower[i], mu - 2 * sd, 1e-9, 'lower');
    close(b.percentB[i], (series[i] - (mu - 2 * sd)) / (4 * sd), 1e-9, '%B');
  }
});

test('Volume analysis: average, relative volume and OBV', () => {
  const candles = [10, 11, 11, 9, 12].map((c, i) => ({ close: c, volume: [100, 200, 300, 400, 500][i], takerBuyVolume: 50 }));
  const v = volumeAnalysis(candles, 2);
  assert.deepEqual(v.average, [null, 150, 250, 350, 450]);
  close(v.relative[4], 500 / 450, 1e-12, 'relative');
  assert.deepEqual(v.obv, [0, 200, 200, -200, 300]);
  close(v.buyShare[0], 0.5, 1e-12, 'buy share');
});

test('Indicators never read future values (prefix invariance)', () => {
  const full = { r: rsi(series), m: macd(series).histogram, e: ema(series, 50), b: bollinger(series).upper };
  for (const cut of [60, 150, 333]) {
    const pre = series.slice(0, cut + 1);
    close(rsi(pre)[cut], full.r[cut], 1e-9, 'rsi');
    close(macd(pre).histogram[cut], full.m[cut], 1e-9, 'macd');
    close(ema(pre, 50)[cut], full.e[cut], 1e-9, 'ema');
    close(bollinger(pre).upper[cut], full.b[cut], 1e-9, 'bb');
  }
});
