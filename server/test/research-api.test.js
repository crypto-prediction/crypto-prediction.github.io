// Replay, Strategy Builder, Risk Simulator and Journal end to end: real app + PostgreSQL + the fake Binance.
import { test as nodeTest, before, after } from 'node:test';

const DB = process.env.TEST_DATABASE_URL || process.env.TEST_PSQL_ARGS;
const test = DB ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set TEST_DATABASE_URL to a disposable PostgreSQL database' }, fn);
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { startMockBinance } from './support/mock-binance.js';
import { createBinanceRest } from '../src/binance/rest.js';
import { createBinanceStream } from '../src/binance/stream.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COINS } from '../src/coins.js';
import { computeAll } from '../src/indicators.js';

const SYMBOLS = COINS.map((c) => c.symbol);
const HOUR = 3600e3;
let mock, server, base, pool, stream, rest;

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS journal_annotations, replay_trades, replay_sessions, strategies, alert_events, alert_rules, forecasts, backtest_runs, paper_equity, paper_trades, paper_positions, paper_accounts CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  rest = createBinanceRest({ baseUrl: mock.rest });
  const made = createApp({ pool, rest, stream, fetchImpl: async () => new Response('', { status: 500 }) });
  server = http.createServer(made.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { stream?.stop(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, b) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
const post = (p, b) => send('POST', p, b);
const accountState = async () => (await pool.query(`SELECT (SELECT cash FROM paper_accounts WHERE id=1) c, (SELECT count(*) FROM paper_trades) t, (SELECT coalesce(string_agg(symbol||qty::text, ','), '') FROM paper_positions) p`)).rows[0];

const startAt = () => Math.floor(Date.now() / HOUR) * HOUR - 500 * HOUR;
const newSession = async (o = {}) => post('/api/replay/sessions', { symbol: 'SOLUSDT', interval: '1h', start: startAt(), cash: 10000, ...o });

// ---- market replay
test('replay reveals only candles up to the cursor', async () => {
  const start = startAt();
  const { status, body: s } = await newSession({ start });
  assert.equal(status, 200, JSON.stringify(s).slice(0, 200));
  assert.equal(s.position, 0);
  assert.equal(s.startTime, start);
  assert.equal(s.asOf, start + HOUR - 1);
  assert.ok(s.candles.every((c) => c.openTime <= start), 'nothing after the first replay candle');
  assert.equal(s.candles.at(-1).openTime, start);
  assert.ok(s.hasMore);
  const text = JSON.stringify(s);
  for (const future of [start + HOUR, start + 2 * HOUR]) assert.ok(!text.includes(String(future)), `no trace of the future candle ${future}`);

  const n = await post(`/api/replay/sessions/${s.id}/step`, { count: 3 });
  assert.equal(n.status, 200);
  assert.equal(n.body.position, 3);
  assert.equal(n.body.moved, 3);
  assert.deepEqual(n.body.candles.map((c) => c.openTime), [start + HOUR, start + 2 * HOUR, start + 3 * HOUR]);
  assert.equal(n.body.replacesChart, false);
  assert.ok(!JSON.stringify(n.body).includes(String(start + 4 * HOUR)));

  const again = await get(`/api/replay/sessions/${s.id}`);
  assert.equal(again.body.candles.at(-1).openTime, start + 3 * HOUR, 'the position is saved');
});

test('replay indicators are computed only from candles already revealed', async () => {
  const { body: s } = await newSession();
  const moved = await post(`/api/replay/sessions/${s.id}/step`, { count: 50 });
  const raw = await rest.klines('SOLUSDT', '1h', 1000);
  const upto = raw.filter((c) => c.openTime <= moved.body.candles.at(-1).openTime);
  // the same candles, recomputed separately, give the same RSI as long as the windows agree
  assert.ok(moved.body.indicators.rsi >= 0 && moved.body.indicators.rsi <= 100);
  const fromPrefix = computeAll(upto);
  const prefixRsi = fromPrefix.rsi14.at(-1);
  assert.ok(Math.abs(prefixRsi - moved.body.indicators.rsi) < 5, 'consistent with a prefix-only calculation');
});

test('replay controls: back, end of data, and input checks', async () => {
  const { body: s } = await newSession();
  await post(`/api/replay/sessions/${s.id}/step`, { count: 10 });
  const back = await post(`/api/replay/sessions/${s.id}/step`, { count: -4 });
  assert.equal(back.body.position, 6);
  assert.equal(back.body.replacesChart, true);
  assert.equal(back.body.candles.at(-1).openTime, s.startTime + 6 * HOUR);
  const floor = await post(`/api/replay/sessions/${s.id}/step`, { count: -100 });
  assert.equal(floor.body.position, 0);
  assert.equal((await post(`/api/replay/sessions/${s.id}/step`, { count: 0 })).status, 400);
  assert.equal((await post(`/api/replay/sessions/${s.id}/step`, { count: 9999 })).status, 400);
  assert.equal((await post('/api/replay/sessions/999999/step', { count: 1 })).status, 404);
  assert.equal((await newSession({ symbol: 'NOPEUSDT' })).status, 400);
  assert.equal((await newSession({ interval: '3y' })).status, 400);
  assert.equal((await newSession({ start: Date.now() + HOUR })).status, 400);
  assert.equal((await newSession({ cash: 1 })).status, 400);
  // a start just before now runs out of candles at the last closed one
  const near = await newSession({ start: Date.now() - 3 * HOUR });
  const end = await post(`/api/replay/sessions/${near.body.id}/step`, { count: 100 });
  assert.equal(end.body.hasMore, false);
  assert.ok(end.body.asOf < Date.now());
});

test('replay orders are simulated, cost fees, stay out of the paper account, and undo on rewind', async () => {
  const before = await accountState();
  const { body: s } = await newSession();
  await post(`/api/replay/sessions/${s.id}/step`, { count: 5 });
  const buy = await post(`/api/replay/sessions/${s.id}/order`, { side: 'BUY', amountUsd: 1000 });
  assert.equal(buy.status, 200, JSON.stringify(buy.body).slice(0, 200));
  assert.ok(Math.abs(buy.body.portfolio.cash - 9000) < 1e-6);
  assert.ok(buy.body.portfolio.qty > 0);
  assert.ok(Math.abs(buy.body.portfolio.feesPaid - 1) < 1e-6, '0.1% fee');
  assert.equal(buy.body.trades[0].candle_index, 5);
  assert.ok(buy.body.trades[0].price > buy.body.price, 'buys pay slippage');
  assert.deepEqual(buy.body.candles, [], 'an order reveals no candles');
  assert.equal((await post(`/api/replay/sessions/${s.id}/order`, { side: 'BUY', amountUsd: 99999 })).status, 400);

  await post(`/api/replay/sessions/${s.id}/step`, { count: 5 });
  const sell = await post(`/api/replay/sessions/${s.id}/order`, { side: 'SELL', closeAll: true });
  assert.equal(sell.body.portfolio.qty, 0);
  assert.equal(sell.body.trades.length, 2);
  assert.equal((await post(`/api/replay/sessions/${s.id}/order`, { side: 'SELL', closeAll: true })).status, 400);

  const back = await post(`/api/replay/sessions/${s.id}/step`, { count: -7 });
  assert.equal(back.body.trades.length, 0, 'stepping back before the buy undoes both trades');
  assert.ok(Math.abs(back.body.portfolio.cash - 10000) < 1e-9);
  assert.deepEqual(await accountState(), before, 'the paper account is untouched');
});

// ---- strategy builder
const example = 'Buy BTC when RSI crosses above 30 and MACD shows a bullish crossover. Sell when RSI reaches 70 or the stop loss is triggered.';
const goodConfig = (o = {}) => ({
  name: 'RSI swing', symbol: 'ETHUSDT', interval: '1h',
  entry: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '<', right: { kind: 'value', value: 45 } }] },
  exit: { logic: 'OR', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '>', right: { kind: 'value', value: 55 } }] },
  stopLossPct: 5, takeProfitPct: 10, positionPct: 100, ...o,
});

test('with no AI, text converts by rules and says so', async () => {
  const r = await post('/api/strategies/parse', { text: example });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'rules');
  assert.equal(r.body.draft.symbol, 'BTCUSDT');
  assert.equal(r.body.draft.entry.conditions.length, 2);
  assert.equal((await post('/api/strategies/parse', { text: ' ' })).status, 400);
});

test('a malicious AI reply is reduced to validated fields, and a bad one falls back to rules', async () => {
  const check = async (reply) => {
    const saved = config.anthropicKey;
    const aiClient = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }) } };
    const made = createApp({ pool, rest, stream, aiClient, fetchImpl: async () => new Response('', { status: 500 }) });
    const s = http.createServer(made.app);
    await new Promise((res) => s.listen(0, '127.0.0.1', res));
    try {
      const url = `http://127.0.0.1:${s.address().port}/api/strategies/parse`;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: example }) });
      return r.json();
    } finally {
      s.close();
      config.anthropicKey = saved;
    }
  };
  const evil = await check(JSON.stringify({ ...goodConfig(), exec: 'process.exit(1)', entry: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14', code: 'x()' }, op: '>', right: { kind: 'value', value: 50 } }] } }));
  assert.equal(evil.mode, 'ai');
  assert.equal(evil.draft.exec, undefined);
  assert.deepEqual(evil.draft.entry.conditions[0].left, { kind: 'indicator', name: 'rsi14' });
  const junk = await check('I cannot do that');
  assert.equal(junk.mode, 'rules');
  assert.match(junk.aiError, /no JSON/);
  assert.equal(junk.draft.symbol, 'BTCUSDT');
});

test('strategies save, backtest, and need approval and confirmation before any paper order', async () => {
  const bad = await post('/api/strategies', { config: goodConfig({ symbol: 'EVIL' }) });
  assert.equal(bad.status, 400);
  const { status, body: s } = await post('/api/strategies', { config: goodConfig(), sourceText: 'typed', sourceMode: 'rules' });
  assert.equal(status, 200);
  assert.equal(s.status, 'draft');

  const test1 = await post(`/api/strategies/${s.id}/backtest`, { bars: 1000 });
  assert.equal(test1.status, 200, JSON.stringify(test1.body).slice(0, 200));
  for (const k of ['totalReturnPct', 'maxDrawdownPct', 'feesPaid', 'slippagePaid', 'trades']) assert.ok(Number.isFinite(test1.body.metrics[k]), k);
  assert.ok(test1.body.verdict);
  assert.ok(!/profitable/i.test(test1.body.verdict));

  const before = await accountState();
  assert.equal((await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 100, confirmed: true })).status, 409, 'not approved yet');
  assert.deepEqual(await accountState(), before);

  const approved = await post(`/api/strategies/${s.id}/approve`);
  assert.equal(approved.body.status, 'approved');
  assert.equal((await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 100 })).status, 400, 'no confirmation');
  assert.deepEqual(await accountState(), before);

  const check = await get(`/api/strategies/${s.id}/check`);
  assert.ok(['enter', 'exit', 'none'].includes(check.body.action));
  assert.equal(check.body.holding, false);
  assert.deepEqual(await accountState(), before, 'checking places no order');

  const order = await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 100, confirmed: true });
  assert.equal(order.status, 200, JSON.stringify(order.body).slice(0, 200));
  assert.equal(order.body.trade.symbol, 'ETHUSDT');
  const j = await get('/api/journal');
  const trip = j.body.trips.find((t) => t.symbol === 'ETHUSDT');
  assert.equal(trip.strategyName, 'RSI swing', 'the journal records which strategy it was');
  assert.match(trip.annotation.entry_reason, /RSI 14 is below 45/);

  const edited = await send('PUT', `/api/strategies/${s.id}`, { config: goodConfig({ name: 'Edited' }) });
  assert.equal(edited.body.status, 'draft', 'an edit needs approving again');
  assert.equal((await post(`/api/strategies/${s.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true })).status, 409);
  await post(`/api/strategies/${s.id}/approve`);
  assert.equal((await post(`/api/strategies/${s.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true })).status, 200);
  await post('/api/paper/reset');
});

test('replay supports a strategy from the builder, and reports without trading', async () => {
  const { body: s } = await post('/api/strategies', { config: goodConfig({ symbol: 'SOLUSDT' }) });
  const { body: r } = await newSession({ strategyId: s.id });
  assert.equal(r.strategy.name, 'RSI swing');
  const moved = await post(`/api/replay/sessions/${r.id}/step`, { count: 100 });
  assert.ok(['enter', 'exit', 'none'].includes(moved.body.strategy.signal.action));
  assert.equal(moved.body.trades.length, 0);
  assert.ok(moved.body.strategy.markers.every((m) => m.time <= moved.body.asOf));
  assert.equal((await newSession({ strategyId: 999999 })).status, 400);
});

// ---- risk simulator
test('the risk simulator uses the real portfolio and writes nothing', async () => {
  await post('/api/paper/reset');
  await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'BUY', amountUsd: 1000 });
  await post('/api/paper/order', { symbol: 'SOLUSDT', side: 'BUY', amountUsd: 500 });
  const before = await accountState();
  const r = await post('/api/risk/simulate', { shocks: { BTCUSDT: -20 }, correlated: true });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual(await accountState(), before);
  assert.equal(r.body.positions.length, 2);
  const btc = r.body.positions.find((p) => p.symbol === 'BTCUSDT');
  assert.equal(btc.shockPct, -20);
  assert.ok(r.body.totalImpactUsd < 0);
  assert.ok(r.body.drawdownPct > 0);
  assert.ok(r.body.var.var95Usd >= 0);
  assert.ok(r.body.var.cvar95Usd >= r.body.var.var95Usd);
  assert.match(r.body.label, /not guaranteed/);
  assert.equal((await post('/api/risk/simulate', { marketShockPct: -500 })).status, 400);

  const whatIf = await post('/api/risk/simulate', { useCurrent: false, hypothetical: [{ symbol: 'DOGEUSDT', valueUsd: 2000 }], marketShockPct: -50 });
  assert.equal(whatIf.body.positions.length, 1);
  assert.equal(whatIf.body.positions[0].symbol, 'DOGEUSDT');
  assert.equal(whatIf.body.moveUsd, -1000);
  assert.deepEqual(await accountState(), before);
  await post('/api/paper/reset');
});

// ---- journal
test('the journal reads real trades, keeps notes apart, and never changes a trade', async () => {
  await post('/api/paper/reset');
  const empty = await get('/api/journal');
  assert.equal(empty.body.totalTrips, 0);
  assert.equal(empty.body.analysis.winRatePct, null);
  assert.equal((await post('/api/journal/review')).status, 404, 'nothing to review, and nothing invented');

  await post('/api/paper/order', { symbol: 'XRPUSDT', side: 'BUY', amountUsd: 300 });
  await post('/api/paper/order', { symbol: 'XRPUSDT', side: 'SELL', closeAll: true });
  const trades = async () => (await pool.query('SELECT * FROM paper_trades ORDER BY id')).rows;
  const before = await trades();

  const { body: j } = await get('/api/journal');
  assert.equal(j.totalTrips, 1);
  const trip = j.trips[0];
  assert.equal(trip.symbol, 'XRPUSDT');
  assert.equal(trip.status, 'closed');
  assert.ok(trip.pnl < 0, 'fees and slippage make an instant round trip a small loss');
  assert.ok(trip.context.trend, 'market conditions from real candles');
  assert.equal(j.analysis.closedTrips, 1);
  assert.match(j.analysis.findings[0], /Only 1 closed trade/);
  assert.equal(j.weekly.length, 1);

  const { body: strat } = await post('/api/strategies', { config: goodConfig({ name: 'Tagged' }) });
  const note = await send('PUT', `/api/journal/trades/${trip.id}/annotation`, { entryReason: 'Saw <b>support</b>', note: 'x'.repeat(5000), strategyId: strat.id });
  assert.equal(note.status, 200);
  assert.equal(note.body.note.length, 1000, 'long notes are capped');
  assert.equal(note.body.entry_reason, 'Saw <b>support</b>', 'stored as plain text; the page never renders it as HTML');
  assert.equal((await send('PUT', '/api/journal/trades/999999/annotation', { note: 'x' })).status, 404);
  assert.equal((await send('PUT', `/api/journal/trades/${trip.id}/annotation`, { strategyId: 999999 })).status, 400);

  const after = await get('/api/journal');
  assert.equal(after.body.trips[0].strategyName, 'Tagged');
  assert.deepEqual(after.body.analysis.byStrategy.map((g) => g.key), ['Tagged']);
  assert.deepEqual(await trades(), before, 'paper trades are byte for byte the same');
  assert.equal((await post('/api/journal/review')).status, 501, 'AI off: refused, not invented');
});

test('journal pagination works', async () => {
  const page = await get('/api/journal?limit=1&offset=5');
  assert.equal(page.body.limit, 1);
  assert.equal(page.body.offset, 5);
  assert.equal(page.body.trips.length, 0);
});
