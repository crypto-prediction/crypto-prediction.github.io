// Binance client tests against mocked HTTP responses and a fake socket.
// Response bodies follow the documented Binance shapes; values are test fixtures.
import { config } from '../src/config.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBinanceRest, BinanceError } from '../src/binance/rest.js';
import { createBinanceStream } from '../src/binance/stream.js';

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const kline = (t, c, closeOffset = 3599999) => [t, String(c), String(c + 1), String(c - 1), String(c), '12.5', t + closeOffset, '1000', 42, '6.0', '500', '0'];

test('klines are parsed and the open candle is flagged', async () => {
  const now = 10 * 3600e3;
  const rest = createBinanceRest({ now: () => now, fetchImpl: async (url) => {
    assert.match(url, /\/api\/v3\/klines\?symbol=BTCUSDT&interval=1h&limit=3/);
    return res(200, [kline(7 * 3600e3, 100), kline(8 * 3600e3, 101), kline(9 * 3600e3 + 1, 102)]);
  } });
  const k = await rest.klines('BTCUSDT', '1h', 3);
  assert.equal(k.length, 3);
  assert.deepEqual([k[0].open, k[0].high, k[0].low, k[0].close, k[0].volume, k[0].takerBuyVolume], [100, 101, 99, 100, 12.5, 6]);
  assert.equal(k[1].closed, true);
  assert.equal(k[2].closed, false, 'candle whose closeTime is in the future is open');
});

test('history pages backwards and stitches without duplicates', async () => {
  const calls = [];
  const rest = createBinanceRest({ fetchImpl: async (url) => {
    const u = new URL(url); calls.push(Object.fromEntries(u.searchParams));
    const end = u.searchParams.get('endTime');
    const limit = Number(u.searchParams.get('limit'));
    const last = end ? Number(end) + 1 - 3600e3 : 2499 * 3600e3;
    const rows = [];
    for (let i = limit - 1; i >= 0; i--) { const t = last - i * 3600e3; if (t >= 0) rows.push(kline(t, 100)); }
    return res(200, rows);
  } });
  const h = await rest.history('ETHUSDT', '1h', 2500);
  assert.equal(h.length, 2500);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].endTime, String(1500 * 3600e3 - 1));
  for (let i = 1; i < h.length; i++) assert.equal(h[i].openTime - h[i - 1].openTime, 3600e3);
});

test('HTTP 429 raises rate_limited and pauses further calls for Retry-After', async () => {
  let t = 0, n = 0;
  const rest = createBinanceRest({ now: () => t, fetchImpl: async () => { n++; return res(429, { code: -1003, msg: 'Too many requests' }, { 'retry-after': '30' }); } });
  await assert.rejects(rest.klines('BTCUSDT', '1h', 10), (e) => e instanceof BinanceError && e.code === 'rate_limited' && e.retryAfterMs === 30000);
  await assert.rejects(rest.klines('BTCUSDT', '1h', 10), /paused/);
  assert.equal(n, 1, 'no request is sent while paused');
  t = 31000;
  await assert.rejects(rest.klines('BTCUSDT', '1h', 10), /rate limit/);
  assert.equal(n, 2);
});

test('5xx and network errors are retried, then succeed', async () => {
  let n = 0;
  const rest = createBinanceRest({ maxRetries: 3, fetchImpl: async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return res(502, {});
    return res(200, { symbol: 'SOLUSDT', price: '150.25' });
  } });
  const p = await rest.price('SOLUSDT');
  assert.equal(p.price, 150.25);
  assert.equal(n, 3);
});

test('4xx errors are not retried and carry the Binance message', async () => {
  let n = 0;
  const rest = createBinanceRest({ fetchImpl: async () => { n++; return res(400, { code: -1121, msg: 'Invalid symbol.' }); } });
  await assert.rejects(rest.klines('BTCUSDT', '1h'), /-1121: Invalid symbol/);
  assert.equal(n, 1);
});

test('HTTP 451 explains the regional restriction', async () => {
  const rest = createBinanceRest({ fetchImpl: async () => res(451, {}) });
  await assert.rejects(rest.tickers24h(), (e) => e.code === 'restricted_location' && /data-api\.binance\.vision/.test(e.message));
});

test('unsupported symbols and intervals are rejected locally', async () => {
  const rest = createBinanceRest({ fetchImpl: async () => { throw new Error('should not be called'); } });
  await assert.rejects(rest.klines('NOTACOINUSDT', '1h'), /Unsupported symbol/);
  await assert.rejects(rest.klines('BTCUSDT', '7m'), /Unsupported interval/);
});

test('24h tickers are parsed to numbers', async () => {
  const rest = createBinanceRest({ fetchImpl: async (url) => {
    assert.ok(decodeURIComponent(url).includes(`symbols=${JSON.stringify(config.symbols)}`));
    return res(200, [{ symbol: 'BTCUSDT', lastPrice: '1.5', priceChange: '-0.1', priceChangePercent: '-6.25', highPrice: '2', lowPrice: '1', volume: '10', quoteVolume: '15', closeTime: 5 }]);
  } });
  const [t] = await rest.tickers24h();
  assert.deepEqual([t.lastPrice, t.priceChangePercent, t.quoteVolume], [1.5, -6.25, 15]);
});

// ---- WebSocket stream with an injected fake socket
class FakeWS extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; FakeWS.instances.push(this); setImmediate(() => this.emit('open')); }
  close() { this.emit('close', 1000); }
  terminate() { this.emit('close', 1006); }
}

test('stream subscribes to ticker + kline streams, parses events and reconnects', async () => {
  FakeWS.instances = [];
  const s = createBinanceStream({ WS: FakeWS, symbols: ['BTCUSDT'], intervals: ['1m', '1h'], backoffBaseMs: 10 });
  const statuses = [];
  s.on('status', (x) => statuses.push(x.status));
  await s.start();
  await new Promise((r) => setImmediate(r));
  const ws = FakeWS.instances[0];
  assert.match(ws.url, /stream\?streams=btcusdt@ticker\/btcusdt@kline_1m\/btcusdt@kline_1h$/);
  assert.equal(s.state.status, 'connected');

  const got = {};
  s.on('ticker', (t) => (got.t = t));
  s.on('kline', (k) => (got.k = k));
  ws.emit('message', Buffer.from(JSON.stringify({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', E: 1000, s: 'BTCUSDT', c: '65000.5', p: '100', P: '0.15', h: '66000', l: '64000', v: '10', q: '650000' } })));
  ws.emit('message', Buffer.from(JSON.stringify({ stream: 'btcusdt@kline_1m', data: { e: 'kline', E: 2000, s: 'BTCUSDT', k: { t: 0, T: 59999, i: '1m', o: '1', c: '65001', h: '2', l: '0.5', v: '3', q: '4', n: 5, V: '1', x: false } } })));
  assert.equal(got.t.lastPrice, 65000.5);
  assert.equal(got.k.close, 65001);
  assert.equal(got.k.closed, false);
  assert.equal(s.livePrice('BTCUSDT').price, 65001, 'newest event wins');

  ws.emit('close', 1006);
  assert.equal(s.state.status, 'disconnected');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(FakeWS.instances.length, 2, 'reconnected');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state.status, 'connected');
  assert.ok(statuses.includes('reconnecting'));
  s.stop();
});

test('live price is reported unavailable once stale', async () => {
  FakeWS.instances = [];
  const s = createBinanceStream({ WS: FakeWS, symbols: ['ETHUSDT'], intervals: ['1m'] });
  await s.start();
  await new Promise((r) => setImmediate(r));
  FakeWS.instances[0].emit('message', Buffer.from(JSON.stringify({ data: { e: '24hrTicker', E: 1, s: 'ETHUSDT', c: '3000', p: '0', P: '0', h: '0', l: '0', v: '0', q: '0' } })));
  assert.equal(s.livePrice('ETHUSDT', 1000).price, 3000);
  s.prices.ETHUSDT.receivedAt -= 5000;
  assert.equal(s.livePrice('ETHUSDT', 1000), null);
  assert.equal(s.livePrice('SOLUSDT'), null);
  s.stop();
});
