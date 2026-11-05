// Backtester and signal-engine tests. All candles here are deterministic TEST FIXTURES built from
// formulas, used only to check the arithmetic and the no-look-ahead guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, validateStrategy } from '../src/backtest.js';
import { analyze, signalAt, wilson, MIN_BARS } from '../src/analysis.js';
import { computeAll } from '../src/indicators.js';

const H = 3600e3;
function fixture(closes) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] * 1.001 : c; // distinct open so "fill at next open" is checkable
    return { openTime: i * H, closeTime: (i + 1) * H - 1, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 100 + (i % 7) * 10, takerBuyVolume: 50, closed: true };
  });
}
const wave = (n, seed = 0) => Array.from({ length: n }, (_, i) => 100 + i * 0.02 + 9 * Math.sin((i + seed) / 9) + 4 * Math.sin((i + seed) / 3.7));

test('trade arithmetic: next-open fill, slippage, fee and P&L are exact', () => {
  // 100 flat-ish bars, then a sharp fall (RSI < 30), then a sharp rise (RSI > 70)
  const closes = [];
  for (let i = 0; i < 100; i++) closes.push(100 + (i % 2 ? 0.1 : -0.1));
  for (let i = 0; i < 15; i++) closes.push(closes[closes.length - 1] * 0.99);
  for (let i = 0; i < 40; i++) closes.push(closes[closes.length - 1] * 1.012);
  const c = fixture(closes);
  const fee = 0.001, slip = 10;
  const r = runBacktest(c, { type: 'rsi_reversion', params: { low: 30, high: 70 }, interval: '1h', feeRate: fee, slippageBps: slip, startingCash: 10000, outOfSamplePct: 10 });
  const t = r.trades[0];
  assert.ok(t, 'expected a trade');
  const entryBar = c.findIndex((x) => x.openTime === t.entryTime);
  const exitBar = c.findIndex((x) => x.openTime === t.exitTime);
  assert.ok(entryBar > 100 && exitBar > entryBar, 'entry after the fall, exit later');
  // fills happen at the NEXT bar's open
  assert.ok(Math.abs(t.entryPrice - c[entryBar].open * (1 + slip / 1e4)) < 1e-9);
  assert.ok(Math.abs(t.exitPrice - c[exitBar].open * (1 - slip / 1e4)) < 1e-9);
  const qty = (10000 - 10000 * fee) / t.entryPrice;
  const proceeds = qty * t.exitPrice * (1 - fee);
  assert.ok(Math.abs(t.qty - qty) < 1e-9);
  assert.ok(Math.abs(t.pnl - (proceeds - 10000)) < 1e-6, `pnl ${t.pnl} vs ${proceeds - 10000}`);
  assert.ok(Math.abs(t.fees - (10000 * fee + qty * t.exitPrice * fee)) < 1e-6);
});

test('metrics are internally consistent', () => {
  const c = fixture(wave(1200));
  const r = runBacktest(c, { type: 'ema_cross', params: { fast: 10, slow: 30 }, interval: '1h' });
  const m = r.metrics;
  assert.equal(m.trades, r.trades.length);
  const wins = r.trades.filter((t) => t.pnl > 0);
  assert.ok(Math.abs(m.winRatePct - (wins.length / m.trades) * 100) < 1e-9);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -r.trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(m.profitFactor - gw / gl) < 1e-9);
  const sumPnl = r.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(m.finalEquity - (10000 + sumPnl)) < 1e-6, 'equity = start + sum of trade P&L');
  assert.ok(m.maxDrawdownPct >= 0 && m.maxDrawdownPct <= 100);
  assert.ok(Math.abs(m.feesPaid - r.trades.reduce((s, t) => s + t.fees, 0)) < 1e-6);
  assert.ok(r.inSample.bars + r.outOfSample.bars === m.bars, 'IS + OOS cover the whole test window');
});

test('changing future candles never changes earlier trades (no look-ahead)', () => {
  const base = wave(1000);
  const k = 700;
  const altered = base.map((v, i) => (i > k ? v * (1 + 0.3 * Math.sin(i)) : v));
  for (const [type, params] of [['ema_cross', { fast: 12, slow: 40 }], ['macd_cross', {}], ['rsi_reversion', {}], ['bb_reversion', {}], ['composite', {}]]) {
    const a = runBacktest(fixture(base), { type, params, interval: '1h', outOfSamplePct: 30 });
    const b = runBacktest(fixture(altered), { type, params, interval: '1h', outOfSamplePct: 30 });
    const cutTime = k * H; // bar k+1 opens at (k+1)*H; trades exiting at or before bar k open are fully decided
    const before = (r) => r.trades.filter((t) => t.exitTime <= cutTime && !t.closedAtEnd).map((t) => [t.entryTime, t.exitTime, t.pnl.toFixed(8)]);
    assert.deepEqual(before(b), before(a), `${type}: past trades changed when only the future changed`);
  }
});

test('signal at bar i is identical whether or not later bars exist', () => {
  const c = fixture(wave(600, 5));
  const full = computeAll(c);
  for (const i of [MIN_BARS + 5, 400, 599]) {
    const pre = c.slice(0, i + 1);
    const s1 = signalAt(full, c, i), s2 = signalAt(computeAll(pre), pre, i);
    assert.equal(s1.signal, s2.signal);
    assert.ok(Math.abs(s1.score - s2.score) < 1e-12);
  }
});

test('analysis ignores the still-open candle and reports evidence', () => {
  const c = fixture(wave(700));
  c[c.length - 1].closed = false;
  c[c.length - 1].close = 1e6; // absurd value in the open candle must not affect the signal
  const a = analyze(c);
  assert.equal(a.barsAnalyzed, 699);
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(a.signal));
  assert.ok(a.confidence >= 0 && a.confidence <= 100);
  assert.ok(a.evidence.occurrences > 0);
  assert.ok(a.evidence.hitRateCI95[0] <= a.evidence.hitRate && a.evidence.hitRate <= a.evidence.hitRateCI95[1]);
  assert.match(a.disclaimer, /not the chance of profit/);
});

test('analysis refuses to run on too little data', () => {
  assert.ok(analyze(fixture(wave(100))).error);
});

test('Wilson interval matches the textbook value', () => {
  const [lo, hi] = wilson(8, 10);
  assert.ok(Math.abs(lo - 0.490) < 0.002 && Math.abs(hi - 0.943) < 0.002, `${lo} ${hi}`);
});

test('strategy parameters are validated (overfitting guard rails)', () => {
  assert.throws(() => validateStrategy('ema_cross', { fast: 60, slow: 50 }), /fast must be smaller/);
  assert.throws(() => validateStrategy('ema_cross', { fast: 2 }), /between/);
  assert.throws(() => validateStrategy('nope'), /Unknown/);
  assert.deepEqual(validateStrategy('rsi_reversion', {}), { low: 30, high: 70 });
});

test('few trades and in-sample-only profits produce warnings', () => {
  const r = runBacktest(fixture(wave(500)), { type: 'ema_cross', params: { fast: 50, slow: 200 }, interval: '1h' });
  assert.ok(r.warnings.some((w) => /not statistically meaningful/.test(w)));
});
