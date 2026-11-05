// Strategy Builder, Risk Simulator, Journal and Replay logic. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backtestStrategy, buildSeries, checkCondition, checkGroup, describeCondition, parseAiDraft, parseStrategyText, strategySignalAt, validateStrategyConfig,
} from '../src/intel/strategy.js';
import { betaToBtc, historicalVar, normalizeScenario, simulateRisk } from '../src/intel/risk.js';
import { analyzeTrips, buildRoundTrips, tradeTiming, weekOf, weeklyReviews } from '../src/intel/journal.js';
import { portfolioFromTrades } from '../src/intel/replay.js';

function candles(n, { base = 100, ms = 3600e3, start = 1_700_000_000_000 } = {}) {
  const out = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const c = base * (1 + 0.05 * Math.sin(i / 17) + 0.02 * Math.sin(i / 5.3) + 0.008 * Math.cos(i / 1.7));
    const v = 100 + 40 * Math.abs(Math.sin(i / 9));
    out.push({ openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1, open: prev, high: Math.max(prev, c) * 1.002, low: Math.min(prev, c) * 0.998, close: c, volume: v, quoteVolume: v * c, trades: 500, takerBuyVolume: v * 0.5, closed: true });
    prev = c;
  }
  return out;
}

const ind = (name) => ({ kind: 'indicator', name });
const val = (value) => ({ kind: 'value', value });
const config = (o = {}) => ({
  name: 'Test', symbol: 'BTCUSDT', interval: '1h',
  entry: { logic: 'AND', conditions: [{ left: ind('rsi14'), op: '<', right: val(45) }] },
  exit: { logic: 'OR', conditions: [{ left: ind('rsi14'), op: '>', right: val(55) }] },
  stopLossPct: null, takeProfitPct: null, positionPct: 100, ...o,
});

// ---- text to rules
test('the example from the brief becomes the right rules, and flags the missing stop level', () => {
  const { draft, warnings } = parseStrategyText('Buy BTC when RSI crosses above 30 and MACD shows a bullish crossover. Sell when RSI reaches 70 or the stop loss is triggered.');
  assert.equal(draft.symbol, 'BTCUSDT');
  assert.equal(draft.entry.logic, 'AND');
  assert.deepEqual(draft.entry.conditions.map(describeCondition), ['RSI 14 crosses above 30', 'MACD line crosses above MACD signal']);
  assert.equal(draft.exit.logic, 'OR');
  assert.deepEqual(draft.exit.conditions.map(describeCondition), ['RSI 14 is at or above 70']);
  assert.equal(draft.stopLossPct, null, 'no level was given, so none is invented');
  assert.ok(warnings.some((w) => /stop loss without a level/.test(w)));
  assert.deepEqual(validateStrategyConfig(draft).errors, []);
});

test('levels, timeframe, position size and indicator comparisons are read', () => {
  const { draft, warnings } = parseStrategyText('Enter ETH on the 4h chart if price crosses above EMA 50 and volume is above 2x average. Exit when price falls below EMA 20. Stop loss 3%, take profit 9%, use 25% of my portfolio.');
  assert.equal(draft.symbol, 'ETHUSDT');
  assert.equal(draft.interval, '4h');
  assert.deepEqual([draft.stopLossPct, draft.takeProfitPct, draft.positionPct], [3, 9, 25]);
  assert.deepEqual(draft.entry.conditions.map(describeCondition), ['Price (close) crosses above EMA 50', 'Relative volume is above 2']);
  assert.deepEqual(draft.exit.conditions.map(describeCondition), ['Price (close) is below EMA 20']);
  assert.deepEqual(warnings, []);
});

test('or rules and band touches are read, and unreadable rules are reported rather than guessed', () => {
  const a = parseStrategyText('Buy DOGE when price touches the lower band or RSI is below 25, sell if RSI above 65');
  assert.equal(a.draft.entry.logic, 'OR');
  assert.deepEqual(a.draft.entry.conditions.map(describeCondition), ['Price (close) is at or below Bollinger lower', 'RSI 14 is below 25']);
  const b = parseStrategyText('Buy SOL when the moon is full and RSI is below 30. Sell when RSI above 70.');
  assert.deepEqual(b.draft.entry.conditions.map(describeCondition), ['RSI 14 is below 30']);
  assert.ok(b.warnings.some((w) => /moon is full/.test(w)));
});

test('prices with thousands and a golden cross are read', () => {
  const { draft } = parseStrategyText('Buy BTC when price is above 85,000 and there is a golden cross. Sell when price is below 80k');
  assert.deepEqual(draft.entry.conditions.map(describeCondition), ['Price (close) is above 85000', 'EMA 50 crosses above EMA 200']);
  assert.deepEqual(draft.exit.conditions.map(describeCondition), ['Price (close) is below 80000']);
});

// ---- validation: the only gate between text or AI output and the engine
test('validation rejects anything outside the restricted format', () => {
  const errs = (o) => validateStrategyConfig(config(o)).errors;
  assert.deepEqual(errs(), []);
  assert.ok(errs({ symbol: 'EVILUSDT' }).length);
  assert.ok(errs({ interval: '3y' }).length);
  assert.ok(errs({ name: '' }).length);
  assert.ok(errs({ entry: { logic: 'AND', conditions: [] } }).length);
  assert.ok(errs({ exit: { logic: 'OR', conditions: [] } }).length, 'a strategy needs some exit');
  assert.ok(errs({ stopLossPct: 90 }).length);
  assert.ok(errs({ positionPct: 500 }).length);
  assert.ok(errs({ entry: { logic: 'AND', conditions: [{ left: ind('process.exit'), op: '>', right: val(1) }] } }).length);
  assert.ok(errs({ entry: { logic: 'AND', conditions: [{ left: ind('constructor'), op: '>', right: val(1) }] } }).length, 'inherited names are not indicators');
  assert.ok(errs({ entry: { logic: 'AND', conditions: [{ left: ind('rsi14'), op: 'eval', right: val(1) }] } }).length);
  assert.ok(errs({ entry: { logic: 'AND', conditions: [{ left: ind('rsi14'), op: '>', right: val(500) }] } }).length, 'RSI runs 0 to 100');
  assert.ok(errs({ entry: { logic: 'AND', conditions: [{ left: ind('rsi14'), op: '>', right: { kind: 'code', value: 'alert(1)' } }] } }).length);
  assert.ok(errs({ entry: { logic: 'AND', conditions: Array(9).fill({ left: ind('rsi14'), op: '>', right: val(1) }) } }).length);
});

test('unknown fields from an AI reply are dropped, and only JSON is accepted', () => {
  const raw = parseAiDraft('Sure!\n```json\n{"name":"X","symbol":"BTCUSDT","interval":"1h","script":"process.exit()","entry":{"logic":"AND","conditions":[{"left":{"kind":"indicator","name":"rsi14","fn":"x"},"op":">","right":{"kind":"value","value":50}}]},"exit":{"logic":"OR","conditions":[]},"takeProfitPct":5}\n```');
  const { config: c, errors } = validateStrategyConfig(raw);
  assert.deepEqual(errors, []);
  assert.equal(c.script, undefined);
  assert.deepEqual(c.entry.conditions[0].left, { kind: 'indicator', name: 'rsi14' });
  assert.throws(() => parseAiDraft('no json here'), /no JSON/);
});

// ---- evaluation
test('conditions, crossovers and groups evaluate correctly, and missing data is not a match', () => {
  const series = { a: [1, 2, 3], b: [2, 2, 2], c: [null, null, 5] };
  const x = (o) => ({ left: ind('a'), op: o, right: ind('b') });
  assert.equal(checkCondition(x('>'), series, 2), true);
  assert.equal(checkCondition(x('<'), series, 0), true);
  assert.equal(checkCondition(x('crosses_above'), series, 2), true);
  assert.equal(checkCondition(x('crosses_above'), series, 1), false, 'touching is not crossing');
  assert.equal(checkCondition(x('crosses_below'), series, 2), false);
  assert.equal(checkCondition({ left: ind('c'), op: '>', right: val(1) }, series, 0), null);
  const g = (logic, conditions) => checkGroup({ logic, conditions }, { ...series }, 2);
  const yes = { left: ind('a'), op: '>', right: val(0) };
  const no = { left: ind('a'), op: '<', right: val(0) };
  assert.equal(g('AND', [yes, no]).met, false);
  assert.equal(g('OR', [yes, no]).met, true);
  assert.equal(g('AND', [yes, { left: ind('c'), op: '>', right: val(99) }]).met, false);
});

test('a strategy signal reports only and depends on whether a position is held', () => {
  const series = buildSeries(candles(300));
  const always = { logic: 'AND', conditions: [{ left: ind('close'), op: '>', right: val(0) }] };
  const c = config({ entry: always, exit: always });
  assert.equal(strategySignalAt(c, series, 250, false).action, 'enter');
  assert.equal(strategySignalAt(c, series, 250, true).action, 'exit');
});

// ---- backtest
test('backtest fills at the next open, charges costs, and equity adds up', () => {
  const r = backtestStrategy(candles(1200), config(), { feeRate: 0.001, slippageBps: 5 });
  assert.ok(r.metrics.trades > 3);
  assert.ok(r.metrics.feesPaid > 0 && r.metrics.slippagePaid > 0);
  const data = candles(1200);
  for (const t of r.trades.filter((x) => !x.closedAtEnd && x.exitReason === 'Exit condition')) {
    const bar = data.find((c) => c.openTime === t.entryTime);
    assert.ok(Math.abs(t.entryPrice - bar.open * 1.0005) < 1e-9, 'entry at next open plus slippage');
  }
  const pnl = r.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(10000 + pnl - (1 + r.metrics.totalReturnPct / 100) * 10000) < 1e-6);
});

test('backtest has no look-ahead: changing later candles leaves earlier trades unchanged', () => {
  const data = candles(1000);
  const cut = 700;
  const changed = data.map((c, i) => (i >= cut ? { ...c, open: c.open * 2, high: c.high * 2, low: c.low * 2, close: c.close * 2 } : c));
  const before = backtestStrategy(data, config());
  const after = backtestStrategy(changed, config());
  const earlyOf = (r) => r.trades.filter((t) => t.exitTime < data[cut - 2].openTime);
  assert.ok(earlyOf(before).length > 1);
  assert.deepEqual(earlyOf(before), earlyOf(after));
});

test('the forming candle is ignored', () => {
  const data = candles(600);
  const a = backtestStrategy(data, config());
  const b = backtestStrategy([...data, { ...data[599], openTime: data[599].openTime + 3600e3, closeTime: data[599].closeTime + 3600e3, close: 9e9, high: 9e9, closed: false }], config());
  assert.deepEqual(a.metrics, b.metrics);
});

test('stops, targets and position size work, and the stop wins when both share a candle', () => {
  const flat = (i, o) => ({ openTime: i * 3600e3, closeTime: (i + 1) * 3600e3 - 1, open: 100, high: 100, low: 100, close: 100, volume: 10, quoteVolume: 1000, trades: 1, takerBuyVolume: 5, closed: true, ...o });
  const build = (spike) => Array.from({ length: 400 }, (_, i) => flat(i, i === 300 ? spike : {}));
  const enterAlways = { logic: 'AND', conditions: [{ left: ind('close'), op: '>', right: val(0) }] };
  const base = { entry: enterAlways, exit: { logic: 'OR', conditions: [] }, stopLossPct: 5, takeProfitPct: 5, positionPct: 50 };
  const noCosts = { feeRate: 0, slippageBps: 0 };
  const stopped = backtestStrategy(build({ low: 90, high: 100 }), config(base), noCosts);
  assert.equal(stopped.trades.find((t) => t.exitReason === 'Stop loss').exitPrice, 95);
  const target = backtestStrategy(build({ high: 110, low: 100 }), config(base), noCosts);
  assert.equal(target.trades.find((t) => t.exitReason === 'Take profit').exitPrice, 105);
  const both = backtestStrategy(build({ high: 110, low: 90 }), config(base), noCosts);
  assert.ok(both.trades.some((t) => t.exitReason === 'Stop loss'));
  assert.ok(!both.trades.some((t) => t.exitReason === 'Take profit'), 'cautious reading: the stop comes first');
  const gap = backtestStrategy(build({ open: 80, low: 80, high: 80, close: 100 }), config(base), noCosts);
  assert.equal(gap.trades.find((t) => t.exitReason === 'Stop loss').exitPrice, 80, 'a gap fills at the worse open');
  assert.equal(stopped.trades[0].cost, 5000, '50% position of $10,000');
});

test('a thin backtest never earns a positive verdict', () => {
  const r = backtestStrategy(candles(500), config({ stopLossPct: 2 }));
  if (r.metrics.trades < 30) assert.equal(r.verdict, 'Insufficient trades');
});

// ---- risk
test('beta and historical VaR match hand calculations', () => {
  const btc = Array.from({ length: 50 }, (_, i) => (i % 2 ? 0.01 : -0.01));
  assert.ok(Math.abs(betaToBtc(btc.map((x) => x * 2), btc) - 2) < 1e-12);
  assert.equal(betaToBtc([0.1], [0.1]), null);
  const returns = Array.from({ length: 100 }, (_, i) => (i + 1) * -0.001);
  const v = historicalVar(returns, 0.95);
  assert.ok(Math.abs(v.var - 0.096) < 1e-12, '5th worst of 100');
  assert.ok(Math.abs(v.cvar - 0.098) < 1e-12, 'average of the 5 worst');
  assert.deepEqual(historicalVar([0.1], 0.95), { var: null, cvar: null });
});

const history = (factor) => Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.01 : -0.01) * factor);

test('a scenario computes losses, costs and drawdown exactly', () => {
  const scenario = normalizeScenario({ shocks: { BTCUSDT: -10 }, correlated: true, feePct: 0.1, slippageBps: 10 });
  const r = simulateRisk({
    positions: [{ symbol: 'BTCUSDT', value: 1000 }, { symbol: 'ETHUSDT', value: 1000 }],
    cash: 8000,
    returnsBySymbol: { BTCUSDT: history(1), ETHUSDT: history(1.5) },
  }, scenario);
  const eth = r.positions.find((p) => p.symbol === 'ETHUSDT');
  assert.ok(Math.abs(eth.beta - 1.5) < 1e-9);
  assert.ok(Math.abs(eth.shockPct + 15) < 1e-9, 'BTC -10% × beta 1.5');
  assert.ok(Math.abs(r.moveUsd + 250) < 1e-9);
  assert.ok(Math.abs(r.exitCostUsd - (900 + 850) * 0.002) < 1e-9);
  assert.ok(Math.abs(r.equityAfter - (10000 - 250 - 3.5)) < 1e-9);
  assert.ok(Math.abs(r.drawdownPct - 2.535) < 1e-9);
  assert.equal(r.concentration.largestPct, 50);
  assert.equal(r.concentration.effectivePositions, 2);
  assert.ok(Math.abs(r.weightedCorrelation - 1) < 1e-9);
  assert.match(r.label, /not guaranteed/);
});

test('explicit coin moves beat the market move, and cheaper conditions cost less', () => {
  const positions = [{ symbol: 'BTCUSDT', value: 1000 }, { symbol: 'SOLUSDT', value: 1000 }];
  const returnsBySymbol = { BTCUSDT: history(1), SOLUSDT: history(2) };
  const run = (s) => simulateRisk({ positions, cash: 0, returnsBySymbol }, normalizeScenario(s));
  const r = run({ marketShockPct: -20, shocks: { SOLUSDT: -50 } });
  assert.equal(r.positions[0].shockPct, -20);
  assert.equal(r.positions[1].shockPct, -50);
  assert.ok(run({ liquidityFactor: 10 }).exitCostUsd > run({}).exitCostUsd);
  assert.ok(run({ volatilityMultiplier: 3 }).var.var95Usd > run({}).var.var95Usd);
});

test('an empty portfolio gives zero exposure rather than invented risk, and inputs are checked', () => {
  const r = simulateRisk({ positions: [], cash: 5000, returnsBySymbol: {} }, normalizeScenario({ marketShockPct: -50 }));
  assert.equal(r.totalImpactUsd, 0);
  assert.equal(r.drawdownPct, 0);
  assert.equal(r.var.var95Usd, null);
  assert.equal(r.dailyVolatilityPct, null);
  assert.throws(() => normalizeScenario({ marketShockPct: -200 }), /between/);
  assert.throws(() => normalizeScenario({ volatilityMultiplier: 'x' }), /between/);
  assert.throws(() => normalizeScenario({ shocks: { NOPE: -1 } }, (s) => s === 'BTCUSDT'), /not available/);
});

// ---- journal
const trade = (id, symbol, side, qty, fill, created, extra = {}) => ({ id, symbol, side, qty, fill_price: fill, notional: qty * fill, fee: qty * fill * 0.001, realized_pnl: null, created_at: new Date(created).toISOString(), ...extra });

test('round trips pair real trades, including partial sells, and never invent any', () => {
  const t0 = Date.UTC(2026, 0, 5);
  const trips = buildRoundTrips([
    trade(1, 'BTCUSDT', 'BUY', 1, 100, t0),
    trade(2, 'ETHUSDT', 'BUY', 2, 50, t0 + 1000),
    trade(3, 'BTCUSDT', 'SELL', 0.5, 110, t0 + 3600e3, { realized_pnl: 4.9 }),
    trade(4, 'BTCUSDT', 'SELL', 0.5, 120, t0 + 7200e3, { realized_pnl: 9.8 }),
  ]);
  assert.equal(trips.length, 2);
  const btc = trips.find((t) => t.symbol === 'BTCUSDT');
  assert.equal(btc.status, 'closed');
  assert.equal(btc.entryPrice, 100);
  assert.equal(btc.exitPrice, 115);
  assert.ok(Math.abs(btc.pnl - 14.7) < 1e-9);
  assert.equal(btc.holdingMs, 7200e3);
  assert.deepEqual(btc.tradeIds, [1, 3, 4]);
  const eth = trips.find((t) => t.symbol === 'ETHUSDT');
  assert.equal(eth.status, 'open');
  assert.equal(eth.pnl, null);
  assert.deepEqual(buildRoundTrips([]), []);
  assert.deepEqual(buildRoundTrips([trade(9, 'XRPUSDT', 'SELL', 1, 1, t0, { realized_pnl: 1 })]), [], 'a sale with no buy is not turned into a trade');
});

test('analysis counts correctly, and refuses to judge a small sample', () => {
  const closed = (pnl, symbol = 'BTCUSDT', extra = {}) => ({ status: 'closed', symbol, pnl, fees: 1, holdingMs: 3600e3, openedAt: Date.UTC(2026, 0, 5), closedAt: Date.UTC(2026, 0, 6), ...extra });
  const few = analyzeTrips([closed(5), closed(-5)]);
  assert.equal(few.winRatePct, 50);
  assert.equal(few.totalPnl, 0);
  assert.equal(few.rewardRisk, 1);
  assert.match(few.findings[0], /Only 2 closed trades/);
  const many = analyzeTrips([closed(1), closed(1), closed(-5), closed(-5), closed(-5), closed(-5)]);
  assert.ok(many.findings.some((f) => /average loss .* bigger than your average win/.test(f)));
  assert.ok(many.findings.some((f) => /weak spot/.test(f)));
  const busy = analyzeTrips(Array.from({ length: 12 }, () => closed(1)));
  assert.ok(busy.findings.some((f) => /overtrading/.test(f)));
  const empty = analyzeTrips([]);
  assert.equal(empty.winRatePct, null);
  assert.equal(empty.avgWin, null);
});

test('weekly reviews group by UTC week, and timing is measured against the price range', () => {
  assert.equal(weekOf(Date.UTC(2026, 10, 5)), '2026-11-02');
  assert.equal(weekOf(Date.UTC(2026, 10, 2)), '2026-11-02');
  assert.equal(weekOf(Date.UTC(2026, 10, 8)), '2026-11-02');
  const trip = (pnl, at) => ({ status: 'closed', symbol: 'BTCUSDT', pnl, fees: 1, holdingMs: 1, openedAt: at, closedAt: at });
  const w = weeklyReviews([trip(2, Date.UTC(2026, 10, 3)), trip(-1, Date.UTC(2026, 10, 4)), trip(5, Date.UTC(2026, 10, 10))]);
  assert.deepEqual(w.map((x) => [x.week, x.trips]), [['2026-11-09', 1], ['2026-11-02', 2]]);
  assert.equal(w[1].best.pnl, 2);
  assert.equal(w[1].worst.pnl, -1);
  const t = tradeTiming({ entryPrice: 100, exitPrice: 110 }, [{ high: 120, low: 90 }, { high: 115, low: 95 }]);
  assert.ok(Math.abs(t.entryEfficiency - 2 / 3) < 1e-12);
  assert.ok(Math.abs(t.exitEfficiency - 2 / 3) < 1e-12);
  assert.equal(tradeTiming({ entryPrice: 1, exitPrice: 1 }, []), null);
});

// ---- replay accounting
test('replay portfolio accounting adds up through buys and partial sells', () => {
  const p0 = portfolioFromTrades([], 1000, 50);
  assert.deepEqual([p0.cash, p0.qty, p0.equity, p0.returnPct], [1000, 0, 1000, 0]);
  const buy = { side: 'BUY', qty: 4, price: 100, fee: 2 };
  const p1 = portfolioFromTrades([buy], 1000, 110);
  assert.equal(p1.cash, 598);
  assert.equal(p1.costBasis, 402);
  assert.equal(p1.equity, 598 + 440);
  assert.equal(p1.unrealizedPnl, 38);
  const sell = { side: 'SELL', qty: 2, price: 120, fee: 1 };
  const p2 = portfolioFromTrades([buy, sell], 1000, 120);
  assert.equal(p2.cash, 598 + 239);
  assert.equal(p2.qty, 2);
  assert.equal(p2.realizedPnl, 239 - 201);
  assert.equal(p2.feesPaid, 3);
  const p3 = portfolioFromTrades([buy, sell, { side: 'SELL', qty: 2, price: 90, fee: 1 }], 1000, 90);
  assert.equal(p3.qty, 0);
  assert.equal(p3.costBasis, 0);
  assert.equal(p3.equity, p3.cash);
  assert.equal(p3.closes, 2);
  assert.equal(p3.winRatePct, 50);
});
