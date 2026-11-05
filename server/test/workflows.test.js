// Whole workflows across modules: real app + PostgreSQL + the fake Binance. Each one crosses several features.
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

const SYMBOLS = COINS.map((c) => c.symbol);
const HOUR = 3600e3;
let mock, server, base, pool, stream;

const feeds = async (url) => {
  const u = String(url);
  if (u.includes('ff_calendar')) return new Response(JSON.stringify([{ title: 'CPI m/m', country: 'USD', date: new Date(Date.now() + 86400e3).toISOString().replace('Z', '-00:00'), impact: 'High', forecast: '0.3%', previous: '0.2%' }]));
  return new Response('', { status: 503 });
};

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS arena_moderation_log, arena_reports, arena_favourites, arena_follows, arena_ratings, arena_comments, arena_verified_trades, arena_strategies, arena_profiles, strategy_orders, journal_annotations, replay_trades, replay_sessions, strategies, calendar_events, research_reports, autopilot_settings, autopilot_runs, autopilot_events, autopilot_audit CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  const rest = createBinanceRest({ baseUrl: mock.rest });
  const made = createApp({ pool, rest, stream, futuresRest: rest, bookFeed: { subscribe: async () => () => {} }, liquidationFeed: { start() {}, stop() {}, purge: async () => {} }, fetchImpl: feeds });
  server = http.createServer(made.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { stream?.stop(); server?.closeAllConnections?.(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, b) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
const post = (p, b) => send('POST', p, b);

const rules = (o = {}) => ({
  name: 'Workflow strategy', symbol: 'BTCUSDT', interval: '1h', stopLossPct: 5, takeProfitPct: 10, positionPct: 25,
  entry: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '<', right: { kind: 'value', value: 45 } }] },
  exit: { logic: 'OR', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '>', right: { kind: 'value', value: 55 } }] },
  ...o,
});

test('idea to record: build, approve, replay, paper trade, journal, risk, publish', async () => {
  await post('/api/paper/reset'); // the test database's account only

  // Strategy Builder: words become reviewed, validated rules
  const parsed = (await post('/api/strategies/parse', { text: 'Buy BTC when RSI is below 40. Sell when RSI is above 60.', symbol: 'BTCUSDT' })).body;
  assert.equal(parsed.mode, 'rules');
  assert.deepEqual(parsed.errors, []);
  const { body: s } = await post('/api/strategies', { config: rules(), sourceMode: 'rules' });
  assert.equal(s.status, 'draft');
  assert.equal((await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 100, confirmed: true })).status, 409);
  await post(`/api/strategies/${s.id}/approve`);

  // Market Replay runs that strategy, and leaves the real account alone
  const start = Math.floor(Date.now() / HOUR) * HOUR - 500 * HOUR;
  const cash = (await get('/api/paper/portfolio')).body.cash;
  const replay = (await post('/api/replay/sessions', { symbol: 'BTCUSDT', interval: '1h', start, cash: 10000, strategyId: s.id })).body;
  assert.equal(replay.strategy.name, 'Workflow strategy');
  const stepped = (await post(`/api/replay/sessions/${replay.id}/step`, { count: 20 })).body;
  assert.ok(stepped.strategy);
  await post(`/api/replay/sessions/${replay.id}/order`, { side: 'BUY', amountUsd: 500 });
  assert.equal((await get('/api/paper/portfolio')).body.cash, cash);

  // a confirmed paper order reaches the existing account and the journal
  const buy = (await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 1000, confirmed: true })).body;
  assert.ok(buy.trade.id);
  const journal = (await get('/api/journal')).body;
  const trip = journal.trips.find((t) => t.tradeIds.map(String).includes(String(buy.trade.id)));
  assert.ok(trip);

  // the Risk Simulator sees that same position and writes nothing
  const before = (await get('/api/paper/portfolio')).body;
  const sim = (await post('/api/risk/simulate', { scenario: { type: 'marketShock', shockPct: -20 } })).body;
  assert.ok(JSON.stringify(sim).includes('BTC'), JSON.stringify(sim).slice(0, 200));
  assert.equal((await get('/api/paper/portfolio')).body.cash, before.cash);

  // the Arena: publish, then only a round trip opened after opting in is credited
  await send('PUT', '/api/arena/me', { handle: 'workflow_user' });
  const pub = (await post('/api/arena/publish', { strategyId: s.id, category: 'mean-reversion', description: 'Workflow test strategy.', sharePaper: true, confirmed: true })).body;
  assert.ok(pub.backtest.metrics);
  await post(`/api/strategies/${s.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true });
  assert.equal((await get(`/api/arena/strategies/${pub.id}`)).body.paper, null);
  await post(`/api/strategies/${s.id}/paper-order`, { side: 'BUY', amountUsd: 300, confirmed: true });
  await post(`/api/strategies/${s.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true });
  const shared = (await get(`/api/arena/strategies/${pub.id}`)).body;
  assert.equal(shared.paper.completedTrades, 1);
  assert.ok(!JSON.stringify(shared).includes('"cash"'));

  // the journal keeps the full history, and stays separate from the Arena's copy
  const after = (await get('/api/journal')).body;
  assert.ok(after.trips.length >= 2);
});

test('market data to report: order book, futures, exchanges, events and forecasts feed one report', async () => {
  const { status, body: r } = await post('/api/reports/generate', { kind: 'daily' });
  assert.equal(status, 200, JSON.stringify(r).slice(0, 200));
  const by = Object.fromEntries(r.content.sections.map((s) => [s.id, s]));
  assert.match(by.book.lines.join(' '), /not confirmed whale/);
  assert.match(by.futures.lines.join(' '), /separate from spot/);
  assert.ok(by.events.events.some((e) => e.title === 'CPI m/m'));
  assert.match(by.performance.lines[0], /forecasts saved/);
  const coin = (await post('/api/reports/generate', { kind: 'coin', symbol: 'BTCUSDT' })).body;
  const liq = coin.content.sections.find((s) => s.id === 'liquidations');
  assert.ok(liq.unavailable || /not known positions/.test(liq.lines[0]));
  const futures = (await get('/api/futures/detail?symbol=BTCUSDT')).body;
  assert.ok('nearestEstimatedLiquidations' in futures); // the estimate informs the futures page, labelled as one
  // derivatives never leak into spot figures
  assert.match((await get('/api/tickers')).body.source, /Binance spot/);
});

test('approved strategy to Autopilot finding, with no change to the account', async () => {
  const before = (await get('/api/paper/portfolio')).body;
  const { rows: [{ n: tradesBefore }] } = await pool.query('SELECT count(*)::int n FROM paper_trades');
  await send('PUT', '/api/autopilot/settings', { symbols: ['BTCUSDT'], intervals: ['1h'] });
  const run = (await post('/api/autopilot/run')).body;
  assert.ok(['ok', 'partial'].includes(run.status), JSON.stringify(run.errors));
  assert.equal(run.steps.find((x) => x.name === 'Evaluate approved strategies').ordersPlaced, 0);
  assert.ok(run.steps.find((x) => x.name === 'Evaluate approved strategies').checked >= 1);
  assert.equal((await get('/api/paper/portfolio')).body.cash, before.cash);
  const { rows: [{ n: tradesAfter }] } = await pool.query('SELECT count(*)::int n FROM paper_trades');
  assert.equal(tradesAfter, tradesBefore);
});
