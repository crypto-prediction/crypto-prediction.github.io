// Backtesting Lab: compares coins, strategies, timeframes and periods using the existing backtester,
// and adds walk-forward validation. It never calls a strategy profitable on thin evidence.
import { runBacktest, runWindow, STRATEGIES, validateStrategy } from '../backtest.js';
import { MIN_BARS } from '../analysis.js';

export const MIN_TRADES = 30;
export const MAX_COMBINATIONS = 120;

const bad = (m) => Object.assign(new Error(m), { status: 400 });

/** A plain reading of the evidence. The best possible result is "held up in this test", never "profitable". */
export function assess(metrics, outOfSample) {
  if (metrics.trades < MIN_TRADES) return { verdict: 'Insufficient trades', detail: `${metrics.trades} trades is below the ${MIN_TRADES} needed to judge a strategy.`, ok: false };
  if (outOfSample && outOfSample.trades < 10) return { verdict: 'Insufficient out-of-sample trades', detail: `Only ${outOfSample.trades} trades in the held-out period.`, ok: false };
  if (outOfSample && outOfSample.totalReturnPct <= 0) return { verdict: 'Failed out of sample', detail: 'It lost money on data held out from the test.', ok: false };
  if (metrics.totalReturnPct <= 0) return { verdict: 'Lost money', detail: 'It lost money over the whole period, even if it beat holding the coin.', ok: false };
  if (metrics.totalReturnPct <= metrics.buyHoldReturnPct) return { verdict: 'Lags buy and hold', detail: 'Simply holding the coin did better over this period.', ok: false };
  return { verdict: 'Held up in this test', detail: 'Past results on one period, which do not show that it will work in future.', ok: true };
}

const row = (m) => ({
  totalReturnPct: m.totalReturnPct, buyHoldReturnPct: m.buyHoldReturnPct, winRatePct: m.winRatePct, maxDrawdownPct: m.maxDrawdownPct,
  profitFactor: m.profitFactor === Infinity ? null : m.profitFactor, sharpe: m.sharpe, trades: m.trades, feesPaid: m.feesPaid, slippagePaid: m.slippagePaid,
  startTime: m.startTime, endTime: m.endTime,
});

export function createLab({ historyFor, isActive, intervals }) {
  async function compare(body = {}) {
    const { symbols = [], strategies = [], periods = [{ bars: 1000, skip: 0 }], feePct = 0.1, slippageBps = 5, outOfSamplePct = 30 } = body;
    const timeframes = body.intervals || ['1h'];
    if (!symbols.length || !strategies.length || !timeframes.length || !periods.length) throw bad('Choose at least one coin, strategy, timeframe and period');
    for (const s of symbols) if (!isActive(s)) throw bad(`${s} is not available`);
    for (const s of strategies) if (!STRATEGIES[s]) throw bad(`Unknown strategy ${s}`);
    for (const i of timeframes) if (!intervals.includes(i)) throw bad(`Unsupported interval ${i}`);
    const combos = symbols.length * strategies.length * timeframes.length * periods.length;
    if (combos > MAX_COMBINATIONS) throw bad(`That is ${combos} runs; the limit is ${MAX_COMBINATIONS}. Choose fewer options.`);

    const results = [];
    for (const symbol of symbols) {
      for (const interval of timeframes) {
        for (const period of periods) {
          const bars = Math.max(300, Math.min(4000, Number(period.bars) || 1000));
          const skip = Math.max(0, Math.min(4000, Number(period.skip) || 0));
          let window = null;
          let loadError = null;
          try {
            const all = (await historyFor(symbol, interval, Math.min(5000, bars + skip))).filter((c) => c.closed !== false);
            const end = all.length - skip;
            window = end > 0 ? all.slice(Math.max(0, end - bars), end) : [];
          } catch (e) { loadError = e.message; }
          for (const strategy of strategies) {
            const base = { symbol, interval, strategy, bars, skip };
            if (loadError) { results.push({ ...base, error: loadError }); continue; }
            try {
              const r = runBacktest(window, { type: strategy, params: {}, interval, feeRate: feePct / 100, slippageBps, outOfSamplePct });
              results.push({ ...base, candles: window.length, ...row(r.metrics), outOfSample: row(r.outOfSample), ...assess(r.metrics, r.outOfSample) });
            } catch (e) {
              results.push({ ...base, error: e.message });
            }
            await new Promise((r) => setImmediate(r)); // keep the server responsive during large comparisons
          }
        }
      }
    }
    return { runs: results.length, minimumTrades: MIN_TRADES, results };
  }

  async function walkForward(body = {}) {
    const { symbol, interval = '1h', strategy = 'ema_cross', bars = 2000, folds = 4, feePct = 0.1, slippageBps = 5 } = body;
    if (!isActive(symbol)) throw bad(`${symbol} is not available`);
    if (!intervals.includes(interval)) throw bad(`Unsupported interval ${interval}`);
    if (!STRATEGIES[strategy]) throw bad(`Unknown strategy ${strategy}`);
    const candles = (await historyFor(symbol, interval, Math.max(500, Math.min(5000, Number(bars) || 2000)))).filter((c) => c.closed !== false);
    return { symbol, interval, strategy, ...runWalkForward(candles, { strategy, interval, folds: Math.max(2, Math.min(8, Number(folds) || 4)), feeRate: feePct / 100, slippageBps }) };
  }

  return { compare, walkForward };
}

/** Candidate settings to choose between on the training data. */
export function paramGrid(strategy) {
  if (strategy === 'ema_cross') return [{ fast: 10, slow: 30 }, { fast: 20, slow: 50 }, { fast: 50, slow: 200 }];
  if (strategy === 'rsi_reversion') return [{ low: 25, high: 65 }, { low: 30, high: 70 }, { low: 35, high: 75 }];
  return [{}];
}

const warmupFor = (strategy, params) => (strategy === 'composite' ? MIN_BARS : strategy === 'ema_cross' ? params.slow + 1 : 40);

/**
 * Anchored walk-forward. Each fold picks settings using only candles before its test window, then trades
 * the window with those settings. Each test sees no candle after its own end, so there is no look-ahead.
 */
export function runWalkForward(candles, { strategy, interval, folds = 4, feeRate = 0.001, slippageBps = 5 }) {
  const grid = paramGrid(strategy).map((p) => validateStrategy(strategy, p));
  const start = Math.floor(candles.length * 0.5);
  const size = Math.floor((candles.length - start) / folds);
  if (size < 50) throw bad(`Not enough candles for ${folds} folds (${candles.length})`);
  const out = [];
  let equity = 1;
  let trades = 0;
  let fees = 0;
  let slippage = 0;
  let worstDrawdown = 0;
  for (let k = 0; k < folds; k++) {
    const from = start + k * size;
    const to = k === folds - 1 ? candles.length - 1 : from + size - 1;
    let best = null;
    for (const params of grid) {
      const warmup = warmupFor(strategy, params);
      if (from - 1 <= warmup) continue;
      const train = runWindow(candles.slice(0, from), { type: strategy, params, interval, from: warmup, to: from - 1, feeRate, slippageBps });
      if (!best || train.totalReturnPct > best.train.totalReturnPct) best = { params, train };
    }
    if (!best) throw bad('Not enough training candles for this strategy');
    const test = runWindow(candles.slice(0, to + 1), { type: strategy, params: best.params, interval, from, to, feeRate, slippageBps });
    equity *= 1 + test.totalReturnPct / 100;
    trades += test.trades;
    fees += test.feesPaid;
    slippage += test.slippagePaid;
    worstDrawdown = Math.max(worstDrawdown, test.maxDrawdownPct);
    out.push({
      fold: k + 1,
      chosenParams: best.params,
      trainReturnPct: best.train.totalReturnPct,
      testReturnPct: test.totalReturnPct,
      buyHoldReturnPct: test.buyHoldReturnPct,
      trades: test.trades,
      winRatePct: test.winRatePct,
      maxDrawdownPct: test.maxDrawdownPct,
      startTime: test.startTime,
      endTime: test.endTime,
    });
  }
  const totalReturnPct = (equity - 1) * 100;
  const buyHoldReturnPct = (candles[candles.length - 1].close / candles[start].open - 1) * 100;
  const summary = { totalReturnPct, buyHoldReturnPct, trades };
  return {
    folds: out,
    testedCandles: candles.length - start,
    totalReturnPct,
    buyHoldReturnPct,
    trades,
    feesPaid: fees,
    slippagePaid: slippage,
    worstFoldDrawdownPct: worstDrawdown,
    foldsPositive: out.filter((f) => f.testReturnPct > 0).length,
    ...assess(summary, summary),
    note: 'Each fold\'s fees are in dollars on a fresh $10,000 stake. The combined return compounds the folds.',
  };
}
