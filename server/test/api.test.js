// End-to-end API test: real app + real PostgreSQL + a fake Binance speaking Binance's formats.
import { test as nodeTest, before, after } from 'node:test';

const DB = process.env.TEST_DATABASE_URL || process.env.TEST_PSQL_ARGS;
const test = DB ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set TEST_DATABASE_URL to a disposable PostgreSQL database' }, fn);
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { startMockBinance } from './support/mock-binance.js';
import { createBinanceRest } from '../src/binance/rest.js';
import { createBinanceStream } from '../src/binance/stream.js';
import { createApp, attachWs } from '../src/app.js';
import { config } from '../src/config.js';

let mock, server, base, pool, stream;

before(async () => {
  if (!DB) return;
  config.anthropicKey = ''; // never call the real Anthropic API from tests, even if the shell has a key
  mock = await startMockBinance();
  if (process.env.TEST_DATABASE_URL) {
    const { createPool } = await import('../src/db.js');
    pool = createPool(process.env.TEST_DATABASE_URL);
  } else {
    const { createPsqlPool } = await import('./support/psql-pool.js');
    pool = createPsqlPool(process.env.TEST_PSQL_ARGS.split(' '));
  }
  await pool.query('DROP TABLE IF EXISTS backtest_runs, paper_equity, paper_trades, paper_positions, paper_accounts CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const rest = createBinanceRest({ baseUrl: mock.rest });
  stream = createBinanceStream({ baseUrl: mock.ws });
  await stream.start();
  const { app } = createApp({ pool, rest, stream });
  server = http.createServer(app);
  attachWs(server, stream);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 800)); // let the stream deliver prices
});
after(async () => { stream?.stop(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('meta and health', async () => {
  const m = await get('/api/meta');
  assert.deepEqual(m.body.symbols, config.symbols);
  assert.ok(m.body.strategies.ema_cross);
  const h = await get('/api/health');
  assert.equal(h.body.db, 'ok');
  assert.equal(h.body.stream.status, 'connected');
});

test('tickers come from the stream once live', async () => {
  const t = await get('/api/tickers');
  assert.equal(t.status, 200);
  assert.match(t.body.source, /WebSocket/);
  assert.equal(t.body.tickers.length, config.symbols.length);
});

test('candles include aligned indicators and source', async () => {
  const c = await get('/api/candles?symbol=ETHUSDT&interval=1h&limit=300');
  assert.equal(c.status, 200);
  assert.equal(c.body.candles.length, 300);
  assert.equal(c.body.indicators.ema200.length, 300);
  assert.ok(c.body.indicators.ema200[0] !== null, 'EMA200 defined from the first visible bar thanks to the 200-bar lead-in');
  assert.match(c.body.source, /Binance/);
  assert.equal(c.body.candles.at(-1).closed, false);
});

test('analysis returns a signal with evidence', async () => {
  const a = await get('/api/analysis?symbol=BTCUSDT&interval=1h');
  assert.equal(a.status, 200);
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(a.body.signal));
  assert.equal(a.body.components.length, 6);
  assert.equal(a.body.barsAnalyzed, 999, 'open candle excluded');
  const e = await post('/api/analysis/explain', { symbol: 'BTCUSDT', interval: '1h' });
  assert.equal(e.status, 501, 'AI off without a key');
});

test('backtest runs on paged history and is stored', async () => {
  const r = await post('/api/backtest', { symbol: 'SOLUSDT', interval: '1h', strategy: 'ema_cross', params: { fast: 10, slow: 40 }, bars: 2000, feePct: 0.1, slippageBps: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.candlesUsed, 1999);
  assert.ok(r.body.id >= 1);
  assert.ok(r.body.metrics.trades > 0);
  const list = await get('/api/backtests');
  assert.equal(list.body[0].id, r.body.id);
  assert.equal(list.body[0].metrics.trades, r.body.metrics.trades);
  const bad = await post('/api/backtest', { symbol: 'SOLUSDT', interval: '1h', strategy: 'ema_cross', params: { fast: 80, slow: 40 } });
  assert.equal(bad.status, 400);
});

test('paper order fills at the live stream price', async () => {
  const live = stream.livePrice('BTCUSDT');
  const r = await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'BUY', amountUsd: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trade.price_source, 'binance-ws');
  assert.ok(Math.abs(r.body.trade.market_price / live.price - 1) < 0.01);
  assert.ok(Math.abs(r.body.portfolio.cash - 9000) < 1e-6);
  const s = await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'SELL', closeAll: true });
  assert.equal(s.status, 200);
  assert.equal(typeof s.body.trade.realized_pnl, 'number');
  const tr = await get('/api/paper/trades');
  assert.equal(tr.body.length, 2);
  const bad = await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'SELL', amountUsd: 10 });
  assert.equal(bad.status, 400);
});

test('browser WebSocket relay sends tickers and subscribed klines', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const seen = { ticker: 0, kline: [] };
  ws.on('message', (b) => { const m = JSON.parse(b); if (m.type === 'ticker') seen.ticker++; if (m.type === 'kline') seen.kline.push(m.data); });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'subscribe', symbol: 'ETHUSDT', interval: '5m' }));
  // a candle for the default stream can arrive before the server has read the subscribe message
  await new Promise((r) => setTimeout(r, 200));
  seen.kline.length = 0;
  await new Promise((r) => setTimeout(r, 1300));
  ws.close();
  assert.ok(seen.ticker > 0);
  assert.ok(seen.kline.length > 0);
  assert.ok(seen.kline.every((k) => k.symbol === 'ETHUSDT' && k.interval === '5m'), 'only the subscribed stream');
});

test('Binance outage surfaces as a clear 503/429, never fake data', async () => {
  const down = await startMockBinance({ fail: { status: 429, headers: { 'retry-after': '60' } } });
  const { app } = createApp({ pool, rest: createBinanceRest({ baseUrl: down.rest }), stream: null });
  const s2 = http.createServer(app);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/candles?symbol=BTCUSDT&interval=1h`);
  const body = await r.json();
  assert.equal(r.status, 429);
  assert.match(body.error, /rate limit/i);
  assert.equal(body.candles, undefined);
  const o = await fetch(`http://127.0.0.1:${s2.address().port}/api/paper/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 10 }) });
  assert.equal(o.status, 503);
  assert.match((await o.json()).error, /unavailable, so the paper order was not placed/);
  s2.close(); down.close();
});
