// Community Arena logic. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, consistency, creditableTrades, MIN_RANKED_TRADES, paperMetrics, rankStrategies, riskRating } from '../src/intel/arena.js';
import { configHash } from '../src/intel/strategy.js';

const row = (id, m, extra = {}) => ({ id, rating: { count: 0 }, backtest: { metrics: { trades: 50, sharpe: 1, ...m }, consistencyPct: m.consistencyPct ?? 50 }, ...extra });

test('community text is reduced to plain text', () => {
  assert.equal(cleanText('<script>alert(1)</script>hello', 100), 'alert(1)hello');
  assert.equal(cleanText('<img src=x onerror=alert(1)>ok', 100), 'ok');
  assert.equal(cleanText('RSI < 30 and > 20', 100), 'RSI < 30 and > 20');
  assert.equal(cleanText('<<b>script>x', 100), 'x');
  assert.doesNotMatch(cleanText('<scr<i>ipt>y</scr</i>ipt>', 100), /<\/?[a-z]/i);
  assert.equal(cleanText('line one\nline two', 100), 'line one\nline two');
  assert.equal(cleanText('bad\u0000\u0007chars', 100), 'badchars');
  assert.equal(cleanText('x'.repeat(50), 10).length, 10);
  assert.equal(cleanText(null, 10), '');
});

test('the highest return does not win on its own', () => {
  const { ranked } = rankStrategies([
    row(1, { totalReturnPct: 300, maxDrawdownPct: 80, sharpe: 0.4, trades: 31, consistencyPct: 30 }),
    row(2, { totalReturnPct: 40, maxDrawdownPct: 8, sharpe: 1.8, trades: 90, consistencyPct: 80 }),
    row(3, { totalReturnPct: 20, maxDrawdownPct: 12, sharpe: 1.1, trades: 60, consistencyPct: 60 }),
  ]);
  assert.equal(ranked[0].id, 2);
  assert.equal(ranked[0].rank, 1);
  assert.notEqual(ranked[0].id, 1);
  assert.ok(ranked.every((r) => r.score >= 0 && r.score <= 100));
  assert.equal(ranked[0].criteria.duration, null); // a backtest has no verified duration
});

test('too few trades means no rank, with the reason given', () => {
  const { ranked, unranked } = rankStrategies([row(1, { totalReturnPct: 500, maxDrawdownPct: 1, trades: MIN_RANKED_TRADES - 1 }), row(2, { totalReturnPct: 5, maxDrawdownPct: 5, trades: MIN_RANKED_TRADES })]);
  assert.deepEqual(ranked.map((r) => r.id), [2]);
  assert.equal(unranked[0].id, 1);
  assert.equal(unranked[0].rank, null);
  assert.match(unranked[0].reason, /29 completed trades, needs 30/);
});

test('backtest and paper results are ranked separately and never mixed', () => {
  const both = row(1, { totalReturnPct: 50, maxDrawdownPct: 5, trades: 100 });
  const noPaper = rankStrategies([both], 'paper');
  assert.equal(noPaper.ranked.length, 0);
  assert.match(noPaper.unranked[0].reason, /No verified paper results/);
  const paper = { ...both, paper: { completedTrades: 40, totalReturnPct: -3, maxDrawdownPct: 9, sharpe: -0.2, consistencyPct: 40, durationDays: 60 } };
  const view = rankStrategies([paper], 'paper').ranked[0].metrics;
  assert.equal(view.totalReturnPct, -3);
  assert.equal(view.durationDays, 60);
  assert.equal(rankStrategies([paper], 'backtest').ranked[0].metrics.totalReturnPct, 50);
});

test('verified paper metrics hold percentages only and need real closed trades', () => {
  assert.equal(paperMetrics([]), null);
  const t = (side, return_pct, day) => ({ side, return_pct, trade_time: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z` });
  const now = Date.parse('2026-10-21T00:00:00Z');
  const m = paperMetrics([t('BUY', null, 1), t('SELL', 10, 2), t('BUY', null, 3), t('SELL', -10, 4), t('BUY', null, 5)], now);
  assert.equal(m.completedTrades, 2);
  assert.equal(m.durationDays, 20);
  assert.ok(Math.abs(m.totalReturnPct - -1) < 1e-9);
  assert.ok(Math.abs(m.maxDrawdownPct - 10) < 1e-9);
  assert.equal(m.winRatePct, 50);
  for (const banned of ['cash', 'qty', 'notional', 'equity', 'trades', 'balance']) assert.ok(!(banned in m), banned);
  assert.equal(paperMetrics([t('BUY', null, 1)], now).completedTrades, 0);
});

test('a strategy only earns round trips it opened itself, under its exact rules', () => {
  const trade = (id, side, symbol = 'BTCUSDT', qty = 1) => ({ id, side, symbol, qty, created_at: `2026-10-01T00:00:${String(id).padStart(2, '0')}Z` });
  const ids = (trades, hashes) => creditableTrades(trades, new Map(Object.entries(hashes))).map((t) => t.id);
  // clean: strategy buys from flat, adds, and sells
  assert.deepEqual(ids([trade(1, 'BUY'), trade(2, 'BUY'), trade(3, 'SELL', 'BTCUSDT', 2)], { 1: 'a', 2: 'a', 3: 'a' }), [1, 2, 3]);
  // a position bought by hand can't be sold for credit
  assert.deepEqual(ids([trade(1, 'BUY'), trade(2, 'BUY'), trade(3, 'SELL', 'BTCUSDT', 2)], { 2: 'a', 3: 'a' }), []);
  // a manual buy in the middle spoils the sell
  assert.deepEqual(ids([trade(1, 'BUY'), trade(2, 'BUY'), trade(3, 'SELL', 'BTCUSDT', 2)], { 1: 'a', 3: 'a' }), [1]);
  // changed rules mid-trip spoil it, a manual sell spoils it, and the next trip starts clean
  assert.deepEqual(ids([trade(1, 'BUY'), trade(2, 'SELL')], { 1: 'a', 2: 'b' }), [1]);
  assert.deepEqual(ids([trade(1, 'BUY'), trade(2, 'SELL'), trade(3, 'BUY'), trade(4, 'SELL')], { 1: 'a', 3: 'a', 4: 'a' }), [1, 3, 4]);
  // coins are tracked apart, and a sell with no open position earns nothing
  assert.deepEqual(ids([trade(1, 'BUY', 'ETHUSDT'), trade(2, 'BUY', 'BTCUSDT'), trade(3, 'SELL', 'BTCUSDT')], { 2: 'a', 3: 'a' }), [2, 3]);
  assert.deepEqual(ids([trade(1, 'SELL')], { 1: 'a' }), []);
  assert.equal(creditableTrades([trade(1, 'BUY')], new Map([['1', 'a']]))[0].hash, 'a');
});

test('consistency needs enough points', () => {
  assert.equal(consistency([1, 2, 3]), null);
  assert.equal(consistency(Array.from({ length: 21 }, (_, i) => 100 + i)), 100);
  assert.equal(consistency(Array.from({ length: 21 }, (_, i) => 100 - i)), 0);
});

test('the risk rating comes from the rules and the backtest', () => {
  const safe = { stopLossPct: 5, positionPct: 25, interval: '4h' };
  assert.equal(riskRating(safe, { maxDrawdownPct: 8 }).rating, 'Low');
  assert.equal(riskRating(safe, { maxDrawdownPct: 20 }).rating, 'Medium');
  const wild = riskRating({ stopLossPct: null, positionPct: 100, interval: '1m' }, { maxDrawdownPct: 45 });
  assert.equal(wild.rating, 'High');
  assert.ok(wild.reasons.length >= 3);
  assert.equal(riskRating(safe, null).rating, 'Medium');
});

test('the rules hash ignores the name and key order, and changes with the rules', () => {
  const a = { name: 'A', symbol: 'BTCUSDT', interval: '1h', positionPct: 10 };
  assert.equal(configHash(a), configHash({ positionPct: 10, interval: '1h', symbol: 'BTCUSDT', name: 'B' }));
  assert.notEqual(configHash(a), configHash({ ...a, positionPct: 11 }));
});
