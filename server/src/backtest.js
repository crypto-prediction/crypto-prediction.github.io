// Long-only spot backtester.
// Execution model: a signal is read at the CLOSE of bar i using data up to bar i only,
// and the order fills at the OPEN of bar i+1, adjusted for slippage, plus a fee on notional.
import { computeAll, ema } from './indicators.js';
import { signalAt, MIN_BARS } from './analysis.js';

export const INTERVAL_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

export const STRATEGIES = {
  ema_cross: {
    label: 'EMA crossover', params: { fast: [20, 5, 100], slow: [50, 10, 300] },
    desc: 'Long while fast EMA is above slow EMA.',
  },
  rsi_reversion: {
    label: 'RSI mean reversion', params: { low: [30, 5, 50], high: [70, 50, 95] },
    desc: 'Buy when RSI(14) drops below low, sell when it rises above high.',
  },
  macd_cross: { label: 'MACD signal cross', params: {}, desc: 'Long while MACD(12,26,9) is above its signal line.' },
  bb_reversion: { label: 'Bollinger reversion', params: {}, desc: 'Buy a close below the lower band, sell at the middle band.' },
  composite: { label: 'Research signal', params: {}, desc: 'Buy on the dashboard BUY signal, sell on SELL.' },
};

export function validateStrategy(type, params = {}) {
  const def = STRATEGIES[type];
  if (!def) throw Object.assign(new Error(`Unknown strategy ${type}`), { status: 400 });
  const out = {};
  for (const [k, [d, min, max]] of Object.entries(def.params)) {
    const v = params[k] === undefined ? d : Number(params[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw Object.assign(new Error(`${k} must be between ${min} and ${max}`), { status: 400 });
    out[k] = Math.round(v);
  }
  if (type === 'ema_cross' && out.fast >= out.slow) throw Object.assign(new Error('fast must be smaller than slow'), { status: 400 });
  if (type === 'rsi_reversion' && out.low >= out.high) throw Object.assign(new Error('low must be smaller than high'), { status: 400 });
  return out;
}

/** Returns fn(i, holding) -> 1 (want long), 0 (want flat) or null (no change). Reads only bar <= i. */
function makeRule(type, params, candles) {
  const close = candles.map((c) => c.close);
  if (type === 'ema_cross') {
    const f = ema(close, params.fast), s = ema(close, params.slow);
    return (i) => (f[i] === null || s[i] === null ? null : f[i] > s[i] ? 1 : 0);
  }
  const ind = computeAll(candles);
  if (type === 'rsi_reversion') {
    return (i, holding) => {
      const r = ind.rsi14[i];
      if (r === null) return null;
      if (!holding && r < params.low) return 1;
      if (holding && r > params.high) return 0;
      return null;
    };
  }
  if (type === 'macd_cross') {
    return (i) => {
      const m = ind.macd.macd[i], s = ind.macd.signal[i];
      return m === null || s === null ? null : m > s ? 1 : 0;
    };
  }
  if (type === 'bb_reversion') {
    return (i, holding) => {
      const lo = ind.bb.lower[i], mid = ind.bb.middle[i];
      if (lo === null) return null;
      if (!holding && close[i] < lo) return 1;
      if (holding && close[i] >= mid) return 0;
      return null;
    };
  }
  if (type === 'composite') {
    return (i) => {
      const s = signalAt(ind, candles, i);
      if (!s) return null;
      return s.signal === 'BUY' ? 1 : s.signal === 'SELL' ? 0 : null;
    };
  }
  throw new Error(`Unknown strategy ${type}`);
}

function simulate(candles, rule, { from, to, feeRate, slippageBps, startingCash }) {
  const slip = slippageBps / 10000;
  let cash = startingCash, qty = 0, pending = null, open = null, fees = 0, slippagePaid = 0, barsInMarket = 0;
  const trades = [];
  const equity = [];
  let peak = startingCash, maxDD = 0;
  for (let i = from; i <= to; i++) {
    const c = candles[i];
    // 1) fill yesterday's decision at today's open
    if (pending === 1 && qty === 0) {
      const px = c.open * (1 + slip);
      const fee = cash * feeRate;
      qty = (cash - fee) / px;
      fees += fee;
      slippagePaid += qty * (px - c.open);
      open = { entryTime: c.openTime, entryPrice: px, qty, entryFee: fee, cost: cash };
      cash = 0;
    } else if (pending === 0 && qty > 0) {
      const px = c.open * (1 - slip);
      const gross = qty * px, fee = gross * feeRate;
      cash = gross - fee;
      fees += fee;
      slippagePaid += qty * (c.open - px);
      trades.push({ ...open, exitTime: c.openTime, exitPrice: px, exitFee: fee, fees: open.entryFee + fee, pnl: cash - open.cost, returnPct: (cash / open.cost - 1) * 100 });
      qty = 0; open = null;
    }
    pending = null;
    if (qty > 0) barsInMarket++;
    // 2) mark to market at close
    const eq = cash + qty * c.close;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    equity.push({ time: c.closeTime, equity: eq });
    // 3) decide using data up to and including this bar's close; executes next bar
    if (i < to) {
      const want = rule(i, qty > 0);
      if (want !== null && want !== (qty > 0 ? 1 : 0)) pending = want;
    }
  }
  // close any open position at the final close (with slippage and fee) so P&L is realised
  let openAtEnd = false;
  if (qty > 0) {
    const c = candles[to];
    const px = c.close * (1 - slip);
    const gross = qty * px, fee = gross * feeRate;
    cash = gross - fee; fees += fee;
    slippagePaid += qty * (c.close - px);
    trades.push({ ...open, exitTime: c.closeTime, exitPrice: px, exitFee: fee, fees: open.entryFee + fee, pnl: cash - open.cost, returnPct: (cash / open.cost - 1) * 100, closedAtEnd: true });
    equity[equity.length - 1].equity = cash;
    openAtEnd = true;
  }
  return { finalEquity: cash, trades, equity, maxDD, fees, slippagePaid, barsInMarket, openAtEnd };
}

export function backtestMetrics(sim, candles, from, to, startingCash, intervalMs) {
  const { trades, equity } = sim;
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i].equity / equity[i - 1].equity - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const barsPerYear = (365 * 86400e3) / intervalMs;
  const bars = to - from + 1;
  // Buy & hold: buy at the first bar's open with the same slippage/fee, sell at last close.
  return {
    startTime: candles[from].openTime,
    endTime: candles[to].closeTime,
    bars,
    totalReturnPct: (sim.finalEquity / startingCash - 1) * 100,
    buyHoldReturnPct: (candles[to].close / candles[from].open - 1) * 100,
    trades: trades.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    avgTradePct: trades.length ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length : null,
    maxDrawdownPct: sim.maxDD * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : null,
    exposurePct: (sim.barsInMarket / bars) * 100,
    feesPaid: sim.fees,
    slippagePaid: sim.slippagePaid,
    finalEquity: sim.finalEquity,
  };
}

export function downsample(arr, max = 400) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

export function runBacktest(candlesAll, { type, params, interval, feeRate = 0.001, slippageBps = 5, startingCash = 10000, outOfSamplePct = 30 }) {
  const candles = candlesAll.filter((c) => c.closed !== false);
  const p = validateStrategy(type, params);
  if (!(feeRate >= 0 && feeRate <= 0.01)) throw Object.assign(new Error('fee must be between 0% and 1%'), { status: 400 });
  if (!(slippageBps >= 0 && slippageBps <= 100)) throw Object.assign(new Error('slippage must be between 0 and 100 bps'), { status: 400 });
  if (!(outOfSamplePct >= 10 && outOfSamplePct <= 50)) throw Object.assign(new Error('out-of-sample share must be 10–50%'), { status: 400 });
  const warmup = type === 'ema_cross' ? p.slow + 1 : type === 'composite' ? MIN_BARS : 40;
  if (candles.length < warmup + 100) throw Object.assign(new Error(`Need at least ${warmup + 100} closed candles; got ${candles.length}`), { status: 400 });
  const rule = makeRule(type, p, candles);
  const intervalMs = INTERVAL_MS[interval] || 3600e3;
  const from = warmup, to = candles.length - 1;
  const split = Math.floor(to - (to - from) * (outOfSamplePct / 100));
  const opts = { feeRate, slippageBps, startingCash };

  const full = simulate(candles, rule, { from, to, ...opts });
  const isSim = simulate(candles, rule, { from, to: split, ...opts });
  const oosSim = simulate(candles, rule, { from: split + 1, to, ...opts });
  const fullM = backtestMetrics(full, candles, from, to, startingCash, intervalMs);
  const isM = backtestMetrics(isSim, candles, from, split, startingCash, intervalMs);
  const oosM = backtestMetrics(oosSim, candles, split + 1, to, startingCash, intervalMs);

  const warnings = [];
  if (fullM.trades < 30) warnings.push(`Only ${fullM.trades} trades. Results this small are not statistically meaningful.`);
  if (isM.totalReturnPct > 0 && oosM.totalReturnPct < 0) warnings.push('Profitable in-sample but losing out-of-sample: a classic sign of overfitting or a changed market.');
  if (fullM.totalReturnPct < fullM.buyHoldReturnPct) warnings.push('The strategy did worse than simply buying and holding over this period.');
  if (full.openAtEnd) warnings.push('A position was still open at the end; it was closed at the last price with fees and slippage.');

  const bh = candles.slice(from, to + 1).map((c) => ({ time: c.closeTime, value: startingCash * (c.close / candles[from].open) }));
  return {
    strategy: { type, label: STRATEGIES[type].label, params: p, description: STRATEGIES[type].desc },
    assumptions: {
      execution: 'Signal at bar close, fill at next bar open',
      feeRatePct: feeRate * 100, slippageBps, startingCash, longOnly: true,
      outOfSamplePct, splitTime: candles[split].closeTime, warmupBars: warmup,
    },
    metrics: fullM,
    inSample: isM,
    outOfSample: oosM,
    warnings,
    equity: downsample(full.equity.map((e) => ({ time: e.time, value: e.equity }))),
    buyHold: downsample(bh),
    trades: full.trades.slice(-200),
  };
}

/** Metrics for one stretch of candles [from..to]. The rule sees only the candles passed in, so pass none beyond `to`. */
export function runWindow(candles, { type, params = {}, interval = '1h', from, to, feeRate = 0.001, slippageBps = 5, startingCash = 10000 }) {
  const p = validateStrategy(type, params);
  const rule = makeRule(type, p, candles);
  const sim = simulate(candles, rule, { from, to, feeRate, slippageBps, startingCash });
  return backtestMetrics(sim, candles, from, to, startingCash, INTERVAL_MS[interval] || 3600e3);
}
