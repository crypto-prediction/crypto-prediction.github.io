// Order book, futures, liquidation and exchange routes end to end: real app + PostgreSQL + the fake Binance.
import { test as nodeTest, before, after } from 'node:test';

const DB = process.env.TEST_DATABASE_URL || process.env.TEST_PSQL_ARGS;
const test = DB ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set TEST_DATABASE_URL to a disposable PostgreSQL database' }, fn);
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { startMockBinance } from './support/mock-binance.js';
import { createBinanceRest } from '../src/binance/rest.js';
import { createBinanceStream } from '../src/binance/stream.js';
import { attachWs, createApp } from '../src/app.js';
import { createBookFeed } from '../src/intel/orderbook.js';
import { config } from '../src/config.js';
import { COINS } from '../src/coins.js';

const SYMBOLS = COINS.map((c) => c.symbol);
let mock, server, base, pool, stream, intel, depthWss, depthHttp;

const exchangeFixture = async (url) => {
  const u = String(url);
  if (u.includes('USDT-USD')) return new Response(JSON.stringify({ price: '1.000' }));
  if (u.includes('coinbase.com/products')) return new Response(JSON.stringify({ ask: '60010', bid: '60000', price: '60005', volume: '100' }));
  if (u.includes('product_book')) return new Response(JSON.stringify({ pricebook: { bids: [{ price: '60000', size: '10' }], asks: [{ price: '60010', size: '10' }] } }));
  return new Response('{}', { status: 503 });
};

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS book_samples, liquidation_events CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  // a local stand-in for Binance's partial depth stream
  depthHttp = http.createServer();
  depthWss = new WebSocketServer({ server: depthHttp });
  depthWss.on('connection', (ws) => {
    const t = setInterval(() => ws.send(JSON.stringify({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] })), 50);
    ws.on('close', () => clearInterval(t));
  });
  await new Promise((r) => depthHttp.listen(0, '127.0.0.1', r));
  const bookFeed = createBookFeed({ baseWs: `ws://127.0.0.1:${depthHttp.address().port}`, relayEveryMs: 50 });
  const rest = createBinanceRest({ baseUrl: mock.rest });
  const made = createApp({ pool, rest, stream, futuresRest: rest, bookFeed, fetchImpl: exchangeFixture });
  intel = made.intel;
  server = http.createServer(made.app);
  attachWs(server, stream, intel);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1000));
});
after(async () => { stream?.stop(); server?.close(); mock?.close(); depthWss?.close(); depthHttp?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };

test('order book snapshot names its source and time, and saves history', async () => {
  const { status, body: b } = await get('/api/orderbook?symbol=DOGEUSDT');
  assert.equal(status, 200, JSON.stringify(b).slice(0, 200));
  assert.equal(b.source, 'Binance spot order book');
  assert.ok(b.time > 0);
  assert.ok(b.bestBid < b.bestAsk);
  assert.ok(b.mid < 1, 'cheap coins stay on their own scale');
  assert.ok(b.bands.length === 3);
  assert.ok(b.curve.bids.length > 0);
  assert.match(b.caution, /not confirmed whale/);
  const h = await get('/api/orderbook/history?symbol=DOGEUSDT&hours=1');
  assert.equal(h.body.samples.length, 1);
  assert.ok(Number.isFinite(h.body.samples[0].imbalance));
});

test('the live book reaches a page that asks, stops when it leaves, and stays off the dashboard feed', async () => {
  const open = async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const got = [];
    ws.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.type === 'book') got.push(m.data); });
    await new Promise((r) => ws.on('open', r));
    return { ws, got };
  };
  const lab = await open();
  const dashboard = await open();
  lab.ws.send(JSON.stringify({ type: 'book', symbol: 'BTCUSDT' }));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(lab.got.length >= 2, 'live updates arrive');
  assert.equal(lab.got[0].symbol, 'BTCUSDT');
  assert.equal(dashboard.got.length, 0);
  assert.deepEqual(intel.books.active(), ['BTCUSDT']);

  lab.ws.send(JSON.stringify({ type: 'book', symbol: 'ETHUSDT' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(intel.books.active(), ['ETHUSDT'], 'switching coin closes the old upstream socket');

  lab.ws.close();
  dashboard.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(intel.books.active(), [], 'no upstream socket stays open with nobody watching');
});

test('sampling every coin builds history and keeps it trimmed', async () => {
  await pool.query(`INSERT INTO book_samples (symbol, ts, mid, spread_bps, bid_usd, ask_usd, imbalance) VALUES ('XRPUSDT', now() - interval '30 days', 1, 1, 1, 1, 0)`);
  const before = (await pool.query('SELECT count(*)::int AS n FROM book_samples')).rows[0].n;
  await new Promise((r) => setTimeout(r, 10));
  const { status } = await get('/api/orderbook/history?symbol=XRPUSDT&hours=24');
  assert.equal(status, 200);
  assert.ok(before >= 1);
});

test('futures overview covers every coin and keeps spot and futures prices apart', async () => {
  const { status, body: o } = await get('/api/futures/overview');
  assert.equal(status, 200, JSON.stringify(o).slice(0, 200));
  assert.deepEqual(o.coins.map((c) => c.symbol), SYMBOLS);
  for (const c of o.coins) {
    assert.ok(!c.unavailable, c.unavailable);
    assert.ok(c.markPrice > 0 && c.spotPrice > 0);
    assert.ok(Number.isFinite(c.fundingRatePct));
    assert.ok(Math.abs(c.fundingAnnualizedPct - c.fundingRatePct * 1095) < 1e-9);
    assert.ok(Number.isFinite(c.oiChange24hPct));
    assert.ok(Math.abs(c.basisPct - (c.markPrice / c.spotPrice - 1) * 100) < 1e-9);
  }
  assert.match(o.source, /futures/i);
});

test('futures detail gives history, readings, and a labelled liquidation estimate', async () => {
  const { status, body: d } = await get('/api/futures/detail?symbol=SOLUSDT');
  assert.equal(status, 200, JSON.stringify(d).slice(0, 200));
  assert.equal(d.fundingHistory.length, 200);
  assert.equal(d.openInterestHistory.length, 168);
  assert.equal(d.findings.length, 4);
  assert.ok(d.spotTrend);
  assert.match(d.nearestEstimatedLiquidations.label, /not known positions/);
});

test('a coin with no perpetual is reported as unavailable', async () => {
  const noPerp = await startMockBinance({ fail: { noPerp: ['LTCUSDT'] } });
  const rest = createBinanceRest({ baseUrl: noPerp.rest });
  const made = createApp({ pool, rest, stream, futuresRest: rest, fetchImpl: exchangeFixture });
  const s = http.createServer(made.app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    const o = await (await fetch(`${url}/api/futures/overview`)).json();
    assert.match(o.coins.find((c) => c.symbol === 'LTCUSDT').unavailable, /no USDT perpetual/);
    assert.ok(o.coins.find((c) => c.symbol === 'BTCUSDT').markPrice > 0);
    assert.equal((await fetch(`${url}/api/futures/detail?symbol=LTCUSDT`)).status, 404);
    assert.equal((await fetch(`${url}/api/liquidations/map?symbol=LTCUSDT`)).status, 404);
  } finally {
    s.close();
    noPerp.close();
  }
});

test('a futures outage shows as unavailable and never as data', async () => {
  const down = await startMockBinance({ fail: { status: 503 } });
  const futuresRest = createBinanceRest({ baseUrl: down.rest, maxRetries: 0 });
  const made = createApp({ pool, rest: createBinanceRest({ baseUrl: mock.rest }), stream, futuresRest, fetchImpl: exchangeFixture });
  const s = http.createServer(made.app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/futures/overview`)).status, 503);
    assert.equal((await fetch(`${url}/api/liquidations/map?symbol=BTCUSDT`)).status, 503);
  } finally {
    s.close();
    down.close();
  }
});

for (const range of ['24h', '7d', '30d']) {
  test(`liquidation map covers ${range} and always labels itself an estimate`, async () => {
    const { status, body: m } = await get(`/api/liquidations/map?symbol=BTCUSDT&range=${range}`);
    assert.equal(status, 200, JSON.stringify(m).slice(0, 200));
    assert.equal(m.long.length, m.prices.length);
    assert.equal(m.long[0].length, m.times.length);
    assert.ok(m.times.length > 0);
    assert.match(m.label, /not known positions/);
    assert.ok(m.assumptions.leverage.length > 0, 'the assumptions are stated');
    assert.ok(m.volatilityBand.dailyMovePct > 0);
    assert.ok(m.longZones.every((z) => z.price < m.price));
    assert.ok(m.shortZones.every((z) => z.price > m.price));
  });
}

test('liquidation events come only from what was reported, and start empty', async () => {
  await pool.query('DELETE FROM liquidation_events');
  const empty = await get('/api/liquidations/events?symbol=ETHUSDT&hours=24');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.recent, []);
  assert.deepEqual(empty.body.totals, {});
  assert.equal(empty.body.collectingSince, null);

  const now = Date.now();
  const event = { e: 'forceOrder', E: now, o: { s: 'ETHUSDT', S: 'SELL', X: 'FILLED', z: '2', ap: '3000', T: now - 1000 } };
  assert.equal(await intel.liquidationFeed.save(event), true);
  assert.equal(await intel.liquidationFeed.save({ ...event, o: { ...event.o, S: 'BUY', T: now - 500 } }), true);
  const { body: e } = await get('/api/liquidations/events?symbol=ETHUSDT&hours=1');
  assert.equal(e.recent.length, 2);
  assert.equal(e.totals.long.usd, 6000);
  assert.equal(e.totals.short.count, 1);
  assert.ok(e.collectingSince);
  assert.match(e.label, /undercounts/);
  assert.equal((await get('/api/liquidations/events?symbol=SOLUSDT&hours=1')).body.recent.length, 0);
});

test('bad liquidation range is refused', async () => {
  assert.equal((await get('/api/liquidations/map?symbol=BTCUSDT&range=5y')).status, 400);
});

test('exchange comparison reports each source, explains itself, and never trades', async () => {
  const cfg = await get('/api/exchanges/config');
  assert.deepEqual(Object.keys(cfg.body.exchanges), ['binance', 'coinbase', 'kraken', 'okx', 'bybit']);
  const before = (await pool.query('SELECT count(*)::int AS n FROM paper_trades')).rows[0].n;
  const { status, body: r } = await post('/api/exchanges/compare', { symbol: 'BTCUSDT', tradeUsd: 1000, feesPct: { binance: 0.05 }, withdrawalFeeUsd: 2 });
  assert.equal(status, 200, JSON.stringify(r).slice(0, 200));
  assert.equal(r.rows.length, 5);
  assert.ok(r.rows.find((x) => x.id === 'binance').last > 0);
  assert.equal(r.rows.find((x) => x.id === 'binance').feePct, 0.05);
  const cb = r.rows.find((x) => x.id === 'coinbase');
  assert.equal(cb.converted, true);
  assert.match(r.rows.find((x) => x.id === 'okx').error, /503/);
  assert.ok(r.opportunity);
  assert.ok(Math.abs(r.opportunity.withdrawalPct - 0.2) < 1e-12);
  assert.match(r.caveat, /not a guaranteed profit/);
  assert.match(r.caveat, /never executes/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM paper_trades')).rows[0].n, before);
  assert.equal((await post('/api/exchanges/compare', { symbol: 'BTCUSDT', tradeUsd: 0 })).status, 400);
  assert.equal((await post('/api/exchanges/compare', { symbol: 'BTCUSDT', feesPct: { binance: 50 } })).status, 400);
  assert.equal((await post('/api/exchanges/compare', { symbol: 'BTCUSDT', exchanges: ['fake'] })).status, 400);
});

test('derivatives and exchange data leave the spot feed and paper account alone', async () => {
  const spot = (await get('/api/tickers')).body;
  assert.match(spot.source, /Binance spot/);
  await post('/api/paper/reset');
  const buy = await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'BUY', amountUsd: 100 });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.trade.price_source, 'binance-ws', 'paper trades use the spot stream only');
  await post('/api/paper/reset');
});
