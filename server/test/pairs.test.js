// Every configured pair, end to end: real app + real PostgreSQL + the fake Binance fixture.
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
import { createMarkets } from '../src/markets.js';
import { computeAll } from '../src/indicators.js';
import { config } from '../src/config.js';
import { COINS } from '../src/coins.js';

const SYMBOLS = COINS.map((c) => c.symbol);
let mock, server, base, pool, stream;
let delistedMock, delistedServer, delistedBase;

const listen = async (app) => {
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
};

before(async () => {
  if (!DB) return;
  config.anthropicKey = ''; // never call the real Anthropic API from tests
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
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  const main = await listen(createApp({ pool, rest: createBinanceRest({ baseUrl: mock.rest }), stream }).app);
  server = main.s; base = main.url;

  // a second app where Binance no longer lists DOGE
  delistedMock = await startMockBinance({ fail: { delisted: ['DOGEUSDT'] } });
  const rest2 = createBinanceRest({ baseUrl: delistedMock.rest });
  const markets = createMarkets({ rest: rest2, symbols: SYMBOLS });
  await markets.refresh();
  const second = await listen(createApp({ pool, rest: rest2, stream: null, markets }).app);
  delistedServer = second.s; delistedBase = second.url;

  await new Promise((r) => setTimeout(r, 1200)); // let the stream deliver prices
});

after(async () => {
  stream?.stop(); server?.close(); delistedServer?.close(); mock?.close(); delistedMock?.close();
  await pool?.end();
});

const get = async (b, p) => { const r = await fetch(b + p); return { status: r.status, body: await r.json() }; };
const post = async (b, p, body) => {
  const r = await fetch(b + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('meta lists all 10 coins with names and colours for the dashboard', async () => {
  const m = await get(base, '/api/meta');
  assert.deepEqual(m.body.symbols, SYMBOLS);
  assert.equal(m.body.coins.length, 10);
  for (const c of m.body.coins) {
    assert.ok(c.name && c.base && /^#/.test(c.color), c.symbol);
    assert.equal(c.available, true);
  }
});

test('all 10 pairs arrive live over the stream with a current price', async () => {
  const t = await get(base, '/api/tickers');
  assert.match(t.body.source, /WebSocket/);
  assert.deepEqual(t.body.tickers.map((x) => x.symbol).sort(), [...SYMBOLS].sort());
  for (const s of SYMBOLS) assert.ok(stream.livePrice(s), `${s} has a live price`);
});

for (const symbol of SYMBOLS) {
  test(`${symbol}: candles and every indicator come from its own data`, async () => {
    const r = await get(base, `/api/candles?symbol=${symbol}&interval=1h&limit=300`);
    assert.equal(r.status, 200);
    assert.equal(r.body.symbol, symbol);
    const ind = r.body.indicators;
    for (const a of [ind.ema20, ind.ema50, ind.ema200, ind.rsi14, ind.macd.macd, ind.macd.signal, ind.macd.histogram, ind.bb.upper, ind.bb.lower, ind.volume.relative, ind.momentum, ind.volatility]) {
      assert.equal(a.length, 300);
      assert.ok(Number.isFinite(a[299]), 'has a value at the latest bar');
    }
    // recompute directly from this coin's raw klines
    const rest = createBinanceRest({ baseUrl: mock.rest });
    const raw = await rest.klines(symbol, '1h', 500);
    const own = computeAll(raw);
    const i = raw.findIndex((c) => c.openTime === r.body.candles[250].openTime);
    assert.ok(i >= 0);
    assert.ok(Math.abs(own.ema50[i] - ind.ema50[250]) / own.ema50[i] < 0.02, 'EMA 50 matches a separate calculation');
    const s = r.body.snapshot;
    assert.ok(['Uptrend', 'Downtrend', 'Mixed'].includes(s.trend));
    assert.ok(s.rsi >= 0 && s.rsi <= 100);
    assert.ok(s.volatilityPct >= 0);
  });

  test(`${symbol}: research signal, backtest and paper trading`, async () => {
    const a = await get(base, `/api/analysis?symbol=${symbol}&interval=1h`);
    assert.equal(a.status, 200);
    assert.equal(a.body.symbol, symbol);
    assert.ok(['BUY', 'SELL', 'HOLD'].includes(a.body.signal));
    assert.ok(a.body.market.trend);

    const b = await post(base, '/api/backtest', { symbol, interval: '1h', strategy: 'ema_cross', params: { fast: 10, slow: 40 }, bars: 1000, feePct: 0.1, slippageBps: 5 });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.symbol, symbol);
    const m = b.body.metrics;
    for (const k of ['totalReturnPct', 'maxDrawdownPct', 'feesPaid', 'slippagePaid']) assert.ok(Number.isFinite(m[k]), k);
    assert.ok(m.trades > 0, 'the fixture produces trades');
    assert.ok(m.slippagePaid > 0, 'slippage is charged');
    assert.ok(m.winRatePct >= 0 && m.winRatePct <= 100);
    assert.ok(m.profitFactor === null || m.profitFactor >= 0);
    // a trade's prices must be on this coin's own scale
    const live = stream.livePrice(symbol).price;
    assert.ok(b.body.trades[0].entryPrice > live * 0.5 && b.body.trades[0].entryPrice < live * 2);

    await post(base, '/api/paper/reset', {});
    const buy = await post(base, '/api/paper/order', { symbol, side: 'BUY', amountUsd: 1000 });
    assert.equal(buy.status, 200, JSON.stringify(buy.body));
    assert.equal(buy.body.trade.price_source, 'binance-ws');
    const fee = buy.body.trade.fee;
    assert.ok(Math.abs(fee - 1) < 1e-6, '0.1% fee on $1000');
    const held = buy.body.portfolio.positions.find((p) => p.symbol === symbol);
    assert.ok(held.qty > 0);
    assert.ok(held.livePrice > 0);
    assert.ok(Number.isFinite(held.unrealizedPnl));
    assert.ok(held.unrealizedPnl < 0, 'fees and slippage make a fresh position slightly negative');
    assert.ok(Math.abs(buy.body.portfolio.cash - 9000) < 1e-6);

    const sell = await post(base, '/api/paper/order', { symbol, side: 'SELL', closeAll: true });
    assert.equal(sell.status, 200, JSON.stringify(sell.body));
    assert.equal(sell.body.portfolio.positions.length, 0);
    assert.ok(Number.isFinite(sell.body.trade.realized_pnl));
    const closed = sell.body.portfolio.closedCoins.find((c) => c.symbol === symbol);
    assert.ok(Math.abs(closed.realizedPnl - sell.body.trade.realized_pnl) < 1e-6, 'per-coin realised P&L adds up');
    assert.equal(closed.trades, 2);
  });
}

test('positions in several coins are tracked separately', async () => {
  await post(base, '/api/paper/reset', {});
  for (const symbol of SYMBOLS) {
    const r = await post(base, '/api/paper/order', { symbol, side: 'BUY', amountUsd: 500 });
    assert.equal(r.status, 200);
  }
  const p = (await get(base, '/api/paper/portfolio')).body;
  assert.equal(p.positions.length, 10);
  assert.ok(Math.abs(p.cash - 5000) < 1e-6);
  assert.equal(p.allPositionsPriced, true);
  assert.equal(p.trades, 10);
  await post(base, '/api/paper/order', { symbol: 'DOGEUSDT', side: 'SELL', closeAll: true });
  const q = (await get(base, '/api/paper/portfolio')).body;
  assert.equal(q.positions.length, 9);
  assert.equal(q.closedCoins[0].symbol, 'DOGEUSDT');
  assert.equal(q.positions.find((x) => x.symbol === 'XRPUSDT').realizedPnl, 0, 'one coin\'s sale does not touch another');
  await post(base, '/api/paper/reset', {});
});

test('overview gives each coin its own readings', async () => {
  const o = await get(base, '/api/overview?interval=1h');
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.coins.map((c) => c.symbol), SYMBOLS);
  for (const c of o.body.coins) {
    assert.ok(!c.error, c.error);
    assert.ok(['BUY', 'SELL', 'HOLD'].includes(c.signal));
    assert.ok(Number.isFinite(c.rsi) && Number.isFinite(c.macdHistogram) && Number.isFinite(c.momentumPct) && Number.isFinite(c.volatilityPct));
  }
  assert.ok(new Set(o.body.coins.map((c) => c.rsi.toFixed(6))).size > 1, 'readings differ between coins');
});

test('candles can be fetched without indicators for the overview visuals', async () => {
  const c = await get(base, '/api/candles?symbol=XRPUSDT&interval=1h&limit=100&indicators=0');
  assert.equal(c.status, 200);
  assert.equal(c.body.candles.length, 100);
  assert.equal(c.body.indicators, undefined);
  assert.ok(c.body.candles[99].close < 2, 'sub-dollar prices keep their precision');
});

test('a delisted pair is reported, refused, and does not break the others', async () => {
  const m = await get(delistedBase, '/api/meta');
  assert.equal(m.body.symbols.length, 9);
  assert.ok(!m.body.symbols.includes('DOGEUSDT'));
  const doge = m.body.coins.find((c) => c.symbol === 'DOGEUSDT');
  assert.equal(doge.available, false);
  assert.match(doge.reason, /does not currently list/);

  const c = await get(delistedBase, '/api/candles?symbol=DOGEUSDT&interval=1h');
  assert.equal(c.status, 410);
  assert.equal(c.body.code, 'symbol_unavailable');
  assert.equal((await post(delistedBase, '/api/paper/order', { symbol: 'DOGEUSDT', side: 'BUY', amountUsd: 10 })).status, 410);
  assert.equal((await post(delistedBase, '/api/backtest', { symbol: 'DOGEUSDT', interval: '1h' })).status, 410);

  const t = await get(delistedBase, '/api/tickers');
  assert.equal(t.status, 200);
  assert.equal(t.body.tickers.length, 9);
  const o = await get(delistedBase, '/api/overview?interval=1h');
  assert.equal(o.body.coins.length, 9);
  assert.equal((await get(delistedBase, '/api/candles?symbol=BTCUSDT&interval=1h')).status, 200);
});
