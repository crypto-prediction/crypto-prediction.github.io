// The coin list, pair availability checks, 10-pair streaming and the new indicators. No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { COINS, coinInfo, resolveSymbols } from '../src/coins.js';
import { createMarkets } from '../src/markets.js';
import { createBinanceRest } from '../src/binance/rest.js';
import { createBinanceStream } from '../src/binance/stream.js';
import { momentum, volatility } from '../src/indicators.js';
import { marketTrend } from '../src/analysis.js';
import { INTERVALS } from '../src/config.js';

const EXPECTED = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT'];

test('the coin list holds the 10 requested pairs, each with its own colour', () => {
  assert.deepEqual(COINS.map((c) => c.symbol), EXPECTED);
  for (const key of ['symbol', 'base', 'name', 'color']) {
    assert.equal(new Set(COINS.map((c) => c[key])).size, 10, `${key} must be unique`);
  }
  for (const c of COINS) {
    assert.equal(`${c.base}USDT`, c.symbol);
    assert.match(c.color, /^#[0-9A-F]{6}$/);
  }
});

test('SYMBOLS can narrow or extend the list, and an unlisted pair still gets usable details', () => {
  assert.deepEqual(resolveSymbols(undefined), EXPECTED);
  assert.deepEqual(resolveSymbols('btcusdt, ETHUSDT ,ETHUSDT'), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(coinInfo('PEPEUSDT').base, 'PEPE');
  assert.equal(coinInfo('BTCUSDT').name, 'Bitcoin');
});

test('a delisted pair is disabled with a reason and the others stay enabled', async () => {
  const changes = [];
  const m = createMarkets({ rest: { tradableSymbols: async () => new Set(EXPECTED.filter((s) => s !== 'DOGEUSDT')) }, symbols: EXPECTED, onChange: (a) => changes.push(a) });
  assert.equal(await m.refresh(), true);
  assert.equal(m.active().length, 9);
  assert.equal(m.isActive('DOGEUSDT'), false);
  assert.equal(m.isConfigured('DOGEUSDT'), true);
  assert.match(m.reasonFor('DOGEUSDT'), /does not currently list/);
  assert.equal(changes.length, 1, 'the stream is told once');
  await m.refresh();
  assert.equal(changes.length, 1, 'no change, no second notification');
});

test('if Binance cannot be reached, pairs stay enabled and are reported as unverified', async () => {
  const m = createMarkets({ rest: { tradableSymbols: async () => { throw new Error('offline'); } }, symbols: EXPECTED });
  assert.equal(await m.refresh(), false);
  assert.equal(m.active().length, 10);
  assert.equal(m.status().verifiedAt, null);
  assert.equal(m.status().lastError, 'offline');
});

test('tradable pairs are read from exchangeInfo, ignoring halted and non-spot pairs', async () => {
  let called = '';
  const rest = createBinanceRest({ fetchImpl: async (url) => {
    called = decodeURIComponent(url);
    return new Response(JSON.stringify({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'ETHUSDT', status: 'BREAK', isSpotTradingAllowed: true },
      { symbol: 'SOLUSDT', status: 'TRADING', isSpotTradingAllowed: false },
    ] }), { status: 200 });
  } });
  const set = await rest.tradableSymbols();
  assert.deepEqual([...set], ['BTCUSDT']);
  assert.match(called, /exchangeInfo/);
  assert.match(called, /permissions=SPOT/);
});

class FakeWS extends EventEmitter {
  static urls = [];
  constructor(url) { super(); FakeWS.urls.push(url); this.url = url; setImmediate(() => this.emit('open')); }
  close() { this.emit('close', 1000); }
  terminate() { this.emit('close', 1006); }
}

test('the stream subscribes to a ticker and every interval for all 10 pairs, and tracks each price', async () => {
  FakeWS.urls = [];
  const s = createBinanceStream({ WS: FakeWS, symbols: EXPECTED, backoffBaseMs: 1 });
  await s.start();
  const streams = new URL(s.url).searchParams.get('streams').split('/');
  assert.equal(streams.length, 10 * (1 + INTERVALS.length));
  assert.ok(streams.length <= 1024, 'inside the Binance per-connection limit');
  for (const sym of EXPECTED) assert.ok(streams.includes(`${sym.toLowerCase()}@ticker`));
  s.stop();
});

test('removing a pair reconnects without it and forgets its price', async () => {
  FakeWS.urls = [];
  const s = createBinanceStream({ WS: FakeWS, symbols: ['BTCUSDT', 'DOGEUSDT'], intervals: ['1h'], backoffBaseMs: 1 });
  await s.start();
  s.prices.DOGEUSDT = { price: 0.1, eventTime: 1, receivedAt: Date.now() };
  s.setSymbols(['BTCUSDT']);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.livePrice('DOGEUSDT'), null);
  assert.ok(!FakeWS.urls.at(-1).includes('doge'));
  assert.ok(FakeWS.urls.at(-1).includes('btcusdt@ticker'));
  s.stop();
});

test('momentum matches a hand calculation and never reads future values', () => {
  const v = [100, 110, 121];
  const m = momentum(v, 2);
  assert.deepEqual(m.slice(0, 2), [null, null]);
  assert.ok(Math.abs(m[2] - 21) < 1e-9);
  const long = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 10);
  const full = momentum(long, 10);
  const part = momentum(long.slice(0, 40), 10);
  part.forEach((x, i) => assert.equal(x, full[i]));
});

test('volatility matches a naive reference, is zero for steady growth, and never reads future values', () => {
  const steady = Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i);
  assert.ok(volatility(steady, 20)[29] < 1e-9);
  const v = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 2) * 5 + i);
  const out = volatility(v, 20);
  const rets = [];
  for (let j = 40; j <= 59; j++) rets.push((v[j] / v[j - 1] - 1) * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / 20;
  const naive = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / 20);
  assert.ok(Math.abs(out[59] - naive) < 1e-12);
  assert.equal(out[19], null);
  const part = volatility(v.slice(0, 40), 20);
  part.forEach((x, i) => assert.equal(x, out[i]));
});

test('volatility and momentum are scale-free, so cheap and expensive coins compare fairly', () => {
  const big = Array.from({ length: 40 }, (_, i) => 60000 + Math.sin(i) * 500);
  const small = big.map((x) => x / 400000);
  assert.ok(Math.abs(volatility(big)[39] - volatility(small)[39]) < 1e-9);
  assert.ok(Math.abs(momentum(big)[39] - momentum(small)[39]) < 1e-9);
});

test('market trend reads the EMA stack and admits when there is not enough data', () => {
  assert.equal(marketTrend(110, 105, 100), 'Uptrend');
  assert.equal(marketTrend(90, 95, 100), 'Downtrend');
  assert.equal(marketTrend(100, 95, 90 + 20), 'Mixed');
  assert.equal(marketTrend(100, 95, null), 'Not enough data');
});
