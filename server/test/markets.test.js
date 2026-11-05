// Order book, futures, liquidation and exchange logic. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { analyzeDepth, CAUTION, createBookFeed } from '../src/intel/orderbook.js';
import { analyzeDerivatives } from '../src/intel/futures.js';
import { createLiquidationFeed, ESTIMATE_LABEL, estimateLiquidationMap } from '../src/intel/liquidations.js';
import { compareQuotes, createAdapters, createExchanges, walkBook } from '../src/intel/exchanges.js';

// ---- order book
const book = (bidRows, askRows) => ({ bids: bidRows.map(([p, q]) => [String(p), String(q)]), asks: askRows.map(([p, q]) => [String(p), String(q)]) });

test('depth, spread and imbalance match a hand calculation', () => {
  const a = analyzeDepth(book([[99.9, 10], [99, 10], [90, 10]], [[100.1, 5], [101, 5], [110, 5]]));
  assert.equal(a.mid, 100);
  assert.ok(Math.abs(a.spreadBps - 20) < 1e-9);
  const b05 = a.bands.find((b) => b.pct === 0.5);
  assert.ok(Math.abs(b05.bidUsd - 999) < 1e-9, 'only the 99.9 level is within 0.5%');
  assert.ok(Math.abs(b05.askUsd - 500.5) < 1e-9);
  assert.ok(Math.abs(b05.imbalance - (999 - 500.5) / (999 + 500.5)) < 1e-12);
  assert.equal(a.coveredBidPct, 10);
  assert.equal(a.bands.find((b) => b.pct === 1).complete, true);
  assert.equal(analyzeDepth({ bids: [], asks: [] }), null);
  assert.equal(a.caution, CAUTION);
  assert.match(CAUTION, /not confirmed whale/);
});

test('pressure wording follows the imbalance and never claims intent', () => {
  const read = (bid, ask) => analyzeDepth(book([[99.99, bid]], [[100.01, ask]])).pressure;
  assert.equal(read(10, 10).label, 'Balanced');
  assert.equal(read(20, 10).label, 'Moderate buying pressure');
  assert.equal(read(100, 10).label, 'Strong buying pressure');
  assert.equal(read(10, 100).label, 'Strong selling pressure');
  assert.match(read(100, 10).detail, /Visible bids/);
});

test('large orders are found relative to typical size, and changes are reported without guessing why', () => {
  const rows = (big) => [[99.9, 1], [99.8, 1], [99.7, big], [99.6, 1], [99.5, 1], [99.4, 1]];
  const first = analyzeDepth(book(rows(20), [[100.1, 1], [100.2, 1], [100.3, 1]]));
  assert.equal(first.walls.bids.length, 1);
  assert.equal(first.walls.bids[0].price, 99.7);
  assert.equal(first.walls.asks.length, 0);
  const second = analyzeDepth(book(rows(1), [[100.1, 1], [100.2, 1], [100.3, 1]]), { previous: first });
  const gone = second.changes.find((c) => c.kind === 'wall-gone');
  assert.match(gone.text, /filled or cancelled, the book can't say which/);
  const third = analyzeDepth(book(rows(20), [[100.1, 1], [100.2, 1], [100.3, 1]]), { previous: second });
  assert.ok(third.changes.some((c) => c.kind === 'wall-new'));
  const thin = analyzeDepth(book([[99.9, 1]], [[100.1, 1]]), { previous: analyzeDepth(book([[99.9, 10]], [[100.1, 1]])) });
  assert.ok(thin.changes.some((c) => /Bids within 0.5% fell 90%/.test(c.text)));
  const wide = analyzeDepth(book([[99, 1]], [[101, 1]]), { spreadHistory: [1, 1, 1] });
  assert.ok(wide.changes.some((c) => c.kind === 'spread'));
});

class FakeWS extends EventEmitter {
  static all = [];
  constructor(url) { super(); this.url = url; this.closed = false; FakeWS.all.push(this); setImmediate(() => this.emit('open')); }
  close() { this.closed = true; this.emit('close', 1000); }
  terminate() { this.emit('close', 1006); }
}

test('the live book opens one socket per coin, throttles relays, and closes when nobody is watching', async () => {
  FakeWS.all = [];
  const feed = createBookFeed({ baseWs: 'wss://x', WS: FakeWS, relayEveryMs: 50, backoffBaseMs: 1 });
  const got = [];
  const stop1 = await feed.subscribe('BTCUSDT', (b) => got.push(b));
  const stop2 = await feed.subscribe('BTCUSDT', () => {});
  assert.equal(FakeWS.all.length, 1, 'two viewers share one upstream socket');
  assert.match(FakeWS.all[0].url, /btcusdt@depth20@100ms/);
  const send = () => FakeWS.all.at(-1).emit('message', Buffer.from(JSON.stringify({ lastUpdateId: 1, bids: [['1', '1']], asks: [['2', '1']] })));
  send(); send(); send();
  assert.equal(got.length, 1, 'bursts are throttled');
  assert.equal(got[0].source, 'Binance spot order book');
  await new Promise((r) => setTimeout(r, 60));
  send();
  assert.equal(got.length, 2);
  // a dropped connection reconnects while someone watches
  FakeWS.all[0].emit('close', 1006);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.all.length, 2);
  stop1();
  assert.deepEqual(feed.active(), ['BTCUSDT']);
  stop2();
  assert.deepEqual(feed.active(), []);
  assert.equal(FakeWS.all.at(-1).closed, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.all.length, 2, 'no reconnect once nobody is watching');
});

// ---- futures
const row = (o = {}) => ({ fundingRatePct: 0.01, longShortRatio: 1.2, oiChange24hPct: 0, spotChange24hPct: 0, ...o });
const history = Array.from({ length: 100 }, (_, i) => ({ fundingRatePct: 0.01 + i * 0.0001 }));
const reading = (findings, topic) => findings.find((f) => f.topic === topic).reading;

test('funding is judged against the coin\'s own history', () => {
  assert.equal(reading(analyzeDerivatives({ row: row(), fundingHistory: history }), 'Funding'), 'Usual range');
  assert.equal(reading(analyzeDerivatives({ row: row({ fundingRatePct: 0.5 }), fundingHistory: history }), 'Funding'), 'Unusually positive');
  const negative = history.map((h) => ({ fundingRatePct: h.fundingRatePct - 0.02 }));
  assert.equal(reading(analyzeDerivatives({ row: row({ fundingRatePct: -0.5 }), fundingHistory: negative }), 'Funding'), 'Unusually negative');
  assert.match(analyzeDerivatives({ row: row({ fundingRatePct: 0.5 }), fundingHistory: history })[0].text, /Longs are paying shorts/);
});

test('crowding, open interest and conflicts with spot are read from the numbers', () => {
  assert.equal(reading(analyzeDerivatives({ row: row({ longShortRatio: 3 }) }), 'Leverage'), 'Longs may be crowded');
  assert.equal(reading(analyzeDerivatives({ row: row({ longShortRatio: 0.5 }) }), 'Leverage'), 'Shorts may be crowded');
  assert.equal(reading(analyzeDerivatives({ row: row() }), 'Leverage'), 'No clear sign');
  assert.equal(reading(analyzeDerivatives({ row: row({ oiChange24hPct: 5 }) }), 'Open interest'), 'Increasing');
  assert.equal(reading(analyzeDerivatives({ row: row({ oiChange24hPct: -5 }) }), 'Open interest'), 'Decreasing');
  assert.equal(reading(analyzeDerivatives({ row: row({ oiChange24hPct: null }) }), 'Open interest'), 'Unknown');
  assert.equal(reading(analyzeDerivatives({ row: row({ fundingRatePct: -0.01 }), spotTrend: 'Uptrend' }), 'Against spot'), 'Conflict');
  assert.equal(reading(analyzeDerivatives({ row: row({ fundingRatePct: 0.5 }), fundingHistory: history, spotTrend: 'Downtrend' }), 'Against spot'), 'Conflict');
  assert.equal(reading(analyzeDerivatives({ row: row({ spotChange24hPct: -3, oiChange24hPct: 5 }) }), 'Against spot'), 'Worth watching');
  assert.equal(reading(analyzeDerivatives({ row: row(), spotTrend: 'Uptrend' }), 'Against spot'), 'No clear conflict');
});

// ---- liquidation estimate
const H = 3600e3;
const candle = (i, high, low, close) => ({ openTime: i * H, closeTime: (i + 1) * H - 1, high, low, close });

test('a rise in open interest creates long and short zones at the right prices and sizes', () => {
  const map = estimateLiquidationMap({
    price: 100, spanPct: 25, rows: 50,
    candles: [candle(0, 100, 100, 100), candle(1, 100, 100, 100)],
    oiHistory: [{ time: H, usd: 1000 }, { time: 2 * H, usd: 2000 }],
    lsHistory: [{ time: 0, longShare: 0.6 }],
    leverage: [{ leverage: 10, share: 1 }],
  });
  assert.equal(map.times.length, 1);
  // 10x: 10% minus 0.5% maintenance, so longs at 90.5 and shorts at 109.5
  assert.equal(map.longZones.length, 1);
  assert.ok(Math.abs(map.longZones[0].price - 90.5) <= 0.5);
  assert.ok(Math.abs(map.longZones[0].usd - 600) < 1e-9, '60% long share of $1,000');
  assert.ok(Math.abs(map.shortZones[0].price - 109.5) <= 0.5);
  assert.ok(Math.abs(map.shortZones[0].usd - 400) < 1e-9);
  assert.equal(map.label, ESTIMATE_LABEL);
  assert.match(map.label, /not known positions/);
  assert.equal(estimateLiquidationMap({ price: 1, candles: [], oiHistory: [] }), null);
});

test('zones clear once price trades through them, and falling open interest shrinks them', () => {
  const base = { price: 100, spanPct: 25, rows: 50, leverage: [{ leverage: 10, share: 1 }] };
  const rise = [{ time: H, usd: 1000 }, { time: 2 * H, usd: 2000 }];
  const swept = estimateLiquidationMap({ ...base, candles: [candle(0, 100, 100, 100), candle(1, 100, 100, 100), candle(2, 100, 90, 100)], oiHistory: [...rise, { time: 3 * H, usd: 2000 }] });
  assert.equal(swept.longZones.length, 0, 'price fell through the long zone at 90.5');
  assert.equal(swept.shortZones.length, 1, 'the short zone above is still there');
  const shrunk = estimateLiquidationMap({ ...base, candles: [candle(0, 100, 100, 100), candle(1, 100, 100, 100), candle(2, 100, 100, 100)], oiHistory: [...rise, { time: 3 * H, usd: 1000 }] });
  assert.ok(Math.abs(shrunk.longZones[0].usd - 250) < 1e-9, 'half the open interest closed, so half of the $500 remains');
});

test('the estimate has no future data: a later candle cannot change an earlier column', () => {
  const candles = [candle(0, 100, 100, 100), candle(1, 100, 100, 100), candle(2, 100, 100, 100)];
  const oi = [{ time: H, usd: 1000 }, { time: 2 * H, usd: 2000 }, { time: 3 * H, usd: 2500 }];
  const base = { price: 100, oiHistory: oi, spanPct: 25, leverage: [{ leverage: 10, share: 1 }] };
  const a = estimateLiquidationMap({ ...base, candles });
  const b = estimateLiquidationMap({ ...base, candles: [...candles.slice(0, 2), candle(2, 100, 50, 60)] });
  const colOf = (m, grid, c) => m[grid].map((r) => r[c]);
  assert.deepEqual(colOf(a, 'long', 0), colOf(b, 'long', 0));
});

test('the feed saves only filled forced orders for tracked coins, labels sides, and skips duplicates', async () => {
  const stored = new Set();
  const inserts = [];
  const pool = { query: async (_sql, p) => { const k = p.join('|'); inserts.push(p); if (stored.has(k)) return { rowCount: 0 }; stored.add(k); return { rowCount: 1 }; } };
  const feed = createLiquidationFeed({ pool, isTracked: (s) => s === 'BTCUSDT', WS: FakeWS, baseWs: 'wss://x' });
  const msg = (o) => ({ e: 'forceOrder', E: 1, o: { s: 'BTCUSDT', S: 'SELL', X: 'FILLED', z: '2', ap: '100', T: 1700000000000, ...o } });
  assert.equal(await feed.save(msg()), true);
  assert.equal(inserts[0][1], 'long', 'a forced SELL closes a long');
  assert.equal(inserts[0][4], 200);
  assert.equal(await feed.save(msg()), false, 'the same event is not saved twice');
  assert.equal(await feed.save(msg({ S: 'BUY', T: 1700000000001 })), true);
  assert.equal(inserts.at(-1)[1], 'short');
  assert.equal(await feed.save(msg({ s: 'SHIBUSDT' })), false);
  assert.equal(await feed.save(msg({ X: 'NEW', T: 5 })), false);
  assert.equal(await feed.save({ e: 'other' }), false);
  assert.equal(feed.state.saved, 2);
});

test('the feed subscribes to the routed stream path, and reconnects', async () => {
  FakeWS.all = [];
  const feed = createLiquidationFeed({ pool: { query: async () => ({ rowCount: 0 }) }, isTracked: () => true, WS: FakeWS, backoffBaseMs: 1 });
  await feed.start();
  assert.equal(FakeWS.all[0].url, 'wss://fstream.binance.com/market/ws/!forceOrder@arr', 'Binance sends nothing on the old path');
  await new Promise((r) => setImmediate(r));
  assert.equal(feed.state.status, 'connected');
  FakeWS.all[0].emit('close', 1006);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.all.length, 2);
  feed.stop();
  assert.equal(feed.state.status, 'stopped');
});

// ---- exchanges
test('walking the book gives the real average fill, and flags a book too thin for the size', () => {
  const asks = [[100, 1], [101, 1], [102, 1]];
  const small = walkBook(asks, 50);
  assert.equal(small.avgPrice, 100);
  assert.equal(small.slippagePct, 0);
  assert.equal(small.complete, true);
  const big = walkBook(asks, 150);
  assert.ok(Math.abs(big.avgPrice - 150 / (1 + 50 / 101)) < 1e-9);
  assert.ok(big.slippagePct > 0);
  const huge = walkBook(asks, 1e6);
  assert.equal(huge.complete, false);
  assert.ok(Math.abs(huge.filledUsd - 303) < 1e-9);
  assert.equal(walkBook([], 100), null);
  assert.equal(walkBook(null, 100), null);
});

const quote = (bid, ask, extra = {}) => ({ bid, ask, last: (bid + ask) / 2, volumeUsd: 1000, book: { bids: [[bid, 100]], asks: [[ask, 100]] }, ...extra });

test('net difference subtracts fees, slippage and withdrawal exactly', () => {
  const r = compareQuotes({ binance: quote(99.9, 100), okx: quote(101, 101.1) }, { tradeUsd: 1000, feesPct: { binance: 0.1, okx: 0.1 }, withdrawalFeeUsd: 5, base: 'BTC' });
  const o = r.opportunity;
  assert.equal(o.buyAt, 'Binance');
  assert.equal(o.sellAt, 'OKX');
  assert.ok(Math.abs(o.grossPct - 1) < 1e-9);
  assert.ok(Math.abs(o.feePct - 0.2) < 1e-12);
  assert.ok(Math.abs(o.withdrawalPct - 0.5) < 1e-12);
  assert.ok(Math.abs(o.netPct - 0.3) < 1e-9);
  assert.ok(Math.abs(o.netUsd - 3) < 1e-6);
  assert.equal(o.fillsCompletely, true);
  assert.equal(o.networkMinutes, '30–60');
  const okx = r.rows.find((x) => x.id === 'okx');
  assert.ok(okx.diffPct > 0);
  assert.equal(r.referenceExchange, 'Binance');
});

test('USD quotes are converted with the real rate, and left out if the rate is missing', () => {
  const quotes = { binance: quote(100, 100.1), coinbase: quote(99, 99.1) };
  const withRate = compareQuotes(quotes, { usdtUsd: 0.99 });
  const cb = withRate.rows.find((x) => x.id === 'coinbase');
  assert.equal(cb.converted, true);
  assert.ok(Math.abs(cb.bid - 100) < 1e-9, '99 USD / 0.99 = 100 USDT');
  const noRate = compareQuotes(quotes, { usdtUsd: null });
  const cb2 = noRate.rows.find((x) => x.id === 'coinbase');
  assert.equal(cb2.bid, null);
  assert.equal(noRate.opportunity, null, 'no comparison without a real conversion rate');
});

test('an exchange that fails or lacks the coin is reported, and the rest still compare', () => {
  const r = compareQuotes({ binance: quote(100, 100.1), kraken: { error: 'Not listed' }, okx: quote(100.2, 100.3) }, {});
  assert.equal(r.rows.find((x) => x.id === 'kraken').error, 'Not listed');
  assert.ok(r.opportunity);
  assert.equal(compareQuotes({ binance: quote(100, 101) }, {}).opportunity, null, 'one exchange has nothing to compare');
});

test('adapters read each exchange\'s real response format', async () => {
  const fixtures = {
    'api.exchange.coinbase.com/products/BTC-USD/ticker': { ask: '101', bid: '100', price: '100.5', volume: '10' },
    'api.coinbase.com/api/v3/brokerage/market/product_book': { pricebook: { bids: [{ price: '100', size: '1' }], asks: [{ price: '101', size: '1' }] } },
    'api.kraken.com/0/public/Ticker': { error: [], result: { XBTUSDT: { a: ['101', '1', '1'], b: ['100', '1', '1'], c: ['100.5', '0.1'], v: ['1', '10'] } } },
    'api.kraken.com/0/public/Depth': { error: [], result: { XBTUSDT: { bids: [['100', '1', 1]], asks: [['101', '1', 1]] } } },
    'www.okx.com/api/v5/market/ticker': { code: '0', data: [{ bidPx: '100', askPx: '101', last: '100.5', volCcy24h: '1005' }] },
    'www.okx.com/api/v5/market/books': { code: '0', data: [{ bids: [['100', '1', '0', '1']], asks: [['101', '1', '0', '1']] }] },
    'api.bybit.com/v5/market/tickers': { retCode: 0, result: { list: [{ bid1Price: '100', ask1Price: '101', lastPrice: '100.5', turnover24h: '1005' }] } },
    'api.bybit.com/v5/market/orderbook': { retCode: 0, result: { b: [['100', '1']], a: [['101', '1']] } },
  };
  const fetchImpl = async (url) => {
    const key = Object.keys(fixtures).find((k) => url.includes(k));
    return key ? new Response(JSON.stringify(fixtures[key])) : new Response('{}', { status: 404 });
  };
  const a = createAdapters({ rest: {}, fetchImpl });
  for (const id of ['coinbase', 'kraken', 'okx', 'bybit']) {
    const q = await a[id]('BTC');
    assert.equal(q.bid, 100, id);
    assert.equal(q.ask, 101, id);
    assert.equal(q.last, 100.5, id);
    assert.ok(q.volumeUsd > 0, id);
    assert.deepEqual(q.book.bids[0], [100, 1], id);
  }
  await assert.rejects(a.coinbase('NOPE'), /HTTP 404/);
});

test('compare reports unavailable exchanges rather than failing or inventing a price', async () => {
  const rest = { request: async (path) => (path.includes('depth') ? { bids: [['100', '1']], asks: [['101', '1']] } : { bidPrice: '100', askPrice: '101', lastPrice: '100.5', quoteVolume: '5' }) };
  const fetchImpl = async () => new Response('{}', { status: 503 });
  const x = createExchanges({ rest, cached: (_k, _t, f) => f(), fetchImpl });
  const r = await x.compare('BTCUSDT', {});
  assert.equal(r.rows.find((y) => y.id === 'binance').last, 100.5);
  assert.match(r.rows.find((y) => y.id === 'okx').error, /503/);
  assert.equal(r.usdtUsd, null);
  assert.equal(r.opportunity, null);
  assert.match(r.caveat, /not a guaranteed profit/);
  await assert.rejects(x.compare('BTCUSDT', { exchanges: ['nope'] }), /at least one exchange/);
});
