// The intelligence routes end to end: real app + real PostgreSQL + the fake Binance fixture.
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
let mock, server, base, pool, stream, intel;

const RSS = `<rss><channel><item><title>Bitcoin rallies</title><link>https://x.test/a</link><pubDate>Thu, 05 Nov 2026 08:35:37 +0000</pubDate><description>BTC up.</description></item></channel></rss>`;
const fetchImpl = async (url) => {
  if (String(url).includes('blockchain.info')) return new Response(JSON.stringify({ txs: [{ hash: 'abc', time: 5, out: [{ value: 300e8 }] }] }));
  return new Response(RSS);
};

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS alert_events, alert_rules, forecasts, backtest_runs, paper_equity, paper_trades, paper_positions, paper_accounts CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  const made = createApp({ pool, rest: createBinanceRest({ baseUrl: mock.rest }), stream, fetchImpl });
  intel = made.intel;
  server = http.createServer(made.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { stream?.stop(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, b) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
const post = (p, b) => send('POST', p, b);

test('status tells the truth about the model and AI', async () => {
  const s = (await get('/api/intel/status')).body;
  assert.equal(s.forecasting.type, 'statistical');
  assert.equal(s.ai.state, 'not-configured');
  assert.deepEqual(s.horizons, ['15m', '1h', '4h', '24h', '7d']);
});

for (const h of ['15m', '1h', '4h', '24h', '7d']) {
  test(`forecasts for all 10 coins at ${h}`, async () => {
    const { status, body } = await get(`/api/forecast?horizon=${h}`);
    assert.equal(status, 200);
    assert.deepEqual(body.forecasts.map((f) => f.symbol), SYMBOLS);
    for (const f of body.forecasts) {
      assert.ok(!f.unavailable, `${f.symbol}: ${f.unavailable}`);
      assert.ok(f.probabilityUp > 0 && f.probabilityUp < 1);
      assert.ok(Number.isFinite(f.range.low) && Number.isFinite(f.expectedVolatilityPct));
      assert.equal(f.modelType, 'statistical');
    }
    // cheap coins stay on their own price scale
    const doge = body.forecasts.find((f) => f.symbol === 'DOGEUSDT');
    assert.ok(doge.price < 1 && doge.range.high < 1);
  });
}

test('a bad horizon is refused', async () => {
  assert.equal((await get('/api/forecast?horizon=99y')).status, 400);
});

test('the tracker reports nothing before any forecast has resolved', async () => {
  const p = (await get('/api/forecast/performance')).body;
  assert.equal(p.overall.n, 0);
  assert.equal(p.overall.accuracy, null);
  assert.equal(p.overall.brier, null);
  assert.deepEqual(p.byCoin, {});
});

test('the tracker saves each forecast once and scores it against the real later price', async () => {
  const first = await intel.tracker.record();
  assert.equal(first, 50, '10 coins × 5 horizons');
  assert.equal(await intel.tracker.record(), 0, 'the same candle is not saved twice');
  assert.equal(await intel.tracker.resolve(), 0, 'nothing has reached its target time yet');
  // move one saved forecast's target into the past, at a real candle boundary
  const hour = 3600e3;
  const target = Math.floor(Date.now() / hour) * hour - 2 * hour - 1;
  const { rows: [f] } = await pool.query(
    `UPDATE forecasts SET target_time=to_timestamp($1/1000.0), reference_price=1, range_low=0.5, range_high=2 WHERE id=(SELECT id FROM forecasts WHERE symbol='BTCUSDT' AND horizon='1h' LIMIT 1) RETURNING id`, [target]);
  assert.equal(await intel.tracker.resolve(), 1);
  const { rows: [done] } = await pool.query('SELECT * FROM forecasts WHERE id=$1', [f.id]);
  const raw = await createBinanceRest({ baseUrl: mock.rest }).request('/api/v3/klines', { symbol: 'BTCUSDT', interval: '1h', startTime: target + 1 - hour, limit: 1 });
  assert.equal(done.actual_price, Number(raw[0][4]));
  assert.equal(done.outcome_up, true, 'BTC is far above the reference of 1');
  assert.equal(done.in_range, false);
  const p = (await get('/api/forecast/performance')).body;
  assert.equal(p.overall.n, 1);
  assert.equal(p.saved, 50);
  assert.equal(p.pending, 49);
  assert.equal(p.byCoin.BTCUSDT.n, 1);
  assert.equal(p.recent.length, 1);
});

test('the brief covers every coin, with three timeframes', async () => {
  const b = (await get('/api/intel/brief')).body;
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(b.mood));
  assert.equal(b.breadth.total, 10);
  assert.equal(b.multiTimeframe.length, 10);
  assert.deepEqual(Object.keys(b.multiTimeframe[0].trends), ['1h', '4h', '1d']);
  assert.ok(b.risks.length >= 1);
});

test('chat with no AI answers from rules and says so', async () => {
  const r = await post('/api/intel/chat', { question: 'Why is ETH moving?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'rules');
  assert.equal(r.body.ai.state, 'not-configured');
  assert.match(r.body.answer, /Ethereum/);
  assert.equal((await post('/api/intel/chat', { question: '  ' })).status, 400);
});

test('alerts: create, fire once on a real condition, no duplicates, re-arm, delete', async () => {
  const bad = await post('/api/alerts/rules', { symbol: 'BTCUSDT', type: 'price_above' });
  assert.equal(bad.status, 400);
  const empty = await intel.alerts.evaluate();
  assert.deepEqual(empty, { checked: 0, fired: 0 }, 'no rules means no market work');

  const heard = [];
  intel.alerts.events.on('alert', (a) => heard.push(a));
  const { body: rule } = await post('/api/alerts/rules', { symbol: 'XRPUSDT', type: 'price_above', params: { value: 0.0001 }, cooldownMin: 1 });
  const now = Date.now();
  assert.equal((await intel.alerts.evaluate(now)).fired, 1);
  assert.equal((await intel.alerts.evaluate(now + 1000)).fired, 0, 'still true: not a new event');
  assert.equal((await intel.alerts.evaluate(now + 3600e3)).fired, 0, 'still true after the quiet period: not a new event');
  assert.equal(heard.length, 1);
  assert.match(heard[0].message, /XRP is above 0.0001/);

  const list = (await get('/api/alerts/events')).body;
  assert.equal(list.events.length, 1);
  assert.equal(list.unread, 1);
  await post('/api/alerts/events/read');
  assert.equal((await get('/api/alerts/events')).body.unread, 0);

  // condition goes false, then true again, so it fires again
  await pool.query(`UPDATE alert_rules SET params='{"value": 999999}' WHERE id=$1`, [rule.id]);
  assert.equal((await intel.alerts.evaluate(now + 7200e3)).fired, 0);
  await pool.query(`UPDATE alert_rules SET params='{"value": 0.0001}' WHERE id=$1`, [rule.id]);
  assert.equal((await intel.alerts.evaluate(now + 10800e3)).fired, 1);

  // a disabled rule is not checked
  await send('PATCH', `/api/alerts/rules/${rule.id}`, { enabled: false });
  assert.equal((await intel.alerts.evaluate(now + 14400e3)).checked, 0);
  await send('DELETE', `/api/alerts/rules/${rule.id}`);
  assert.equal((await get('/api/alerts/rules')).body.length, 0);
  assert.equal((await get('/api/alerts/events')).body.events.length, 2, 'history outlives the rule');
});

test('every alert type runs against live-format data without errors', async () => {
  const types = [['rsi_overbought', {}], ['rsi_oversold', {}], ['macd_cross', {}], ['unusual_volume', {}], ['breakout', {}], ['support_breakdown', {}], ['high_volatility', {}], ['forecast_change', { horizon: '1h' }], ['price_below', { value: 1e9 }], ['custom', { metric: 'rsi', op: '>', value: 0 }]];
  for (const [type, params] of types) {
    const r = await post('/api/alerts/rules', { symbol: 'SOLUSDT', type, params });
    assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
  }
  const out = await intel.alerts.evaluate();
  assert.equal(out.checked, types.length);
  assert.ok(out.fired >= 2, 'price_below and custom are certainly true');
  const { rows } = await pool.query(`SELECT state FROM alert_rules`);
  assert.ok(rows.every((r) => r.state.checkedAt), 'every rule was actually evaluated');
  await pool.query('DELETE FROM alert_rules');
});

test('portfolio intelligence reads the account and never changes it', async () => {
  await post('/api/paper/reset');
  await post('/api/paper/order', { symbol: 'BTCUSDT', side: 'BUY', amountUsd: 500 });
  const counts = async () => (await pool.query(`SELECT (SELECT cash FROM paper_accounts WHERE id=1) c, (SELECT count(*) FROM paper_trades) t, (SELECT count(*) FROM paper_positions) p, (SELECT string_agg(qty::text, ',') FROM paper_positions) q`)).rows[0];
  const before = await counts();
  const { status, body: d } = await get('/api/portfolio/intel');
  assert.equal(status, 200);
  assert.deepEqual(await counts(), before);
  assert.equal(d.cash, 9500);
  assert.equal(d.exposure.length, 1);
  assert.equal(d.correlation.symbols.length, 10);
  assert.deepEqual(d.correlation.held, ['BTCUSDT']);
  assert.equal(d.correlation.matrix[0][0], 1);
  assert.ok(d.risk.dailyVolatilityPct > 0);
});

test('activity separates exchange from on-chain, and marks unconnected sources', async () => {
  const { status, body: a } = await get('/api/activity?symbol=DOGEUSDT');
  assert.equal(status, 200);
  assert.ok(a.exchange.orderBook.bidDepthUsd > 0);
  assert.match(a.exchange.source, /not on-chain/);
  assert.equal(a.onChain.bitcoin.status, 'connected');
  assert.equal(a.onChain.bitcoin.transfers[0].btc, 300);
  assert.equal(a.onChain.otherChains.status, 'not-connected');
  assert.equal(a.onChain.exchangeFlows.status, 'not-connected');
  assert.ok(!('orderBook' in a.onChain));
});

test('news keeps publisher fields apart from the estimate, and filters by coin', async () => {
  const { body } = await get('/api/news');
  assert.equal(body.articles[0].published.link, 'https://x.test/a');
  assert.ok(!('sentiment' in body.articles[0].published));
  assert.equal(body.articles[0].interpretation.sentiment, 'Positive');
  assert.equal((await get('/api/news?symbol=BTCUSDT')).body.articles.length, 1);
  assert.equal((await get('/api/news?symbol=XRPUSDT')).body.articles.length, 0);
  assert.equal((await post('/api/news/digest', {})).status, 501, 'no AI: refused, not invented');
});

test('lab compares coins, strategies, timeframes and periods', async () => {
  const r = await post('/api/lab/compare', { symbols: ['BTCUSDT', 'DOGEUSDT'], strategies: ['ema_cross', 'macd_cross'], intervals: ['1h', '4h'], periods: [{ bars: 1000, skip: 0 }, { bars: 1000, skip: 1000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.runs, 16);
  for (const x of r.body.results) {
    assert.ok(!x.error, x.error);
    for (const k of ['totalReturnPct', 'maxDrawdownPct', 'feesPaid', 'slippagePaid']) assert.ok(Number.isFinite(x[k]), k);
    assert.ok(x.verdict);
    if (x.trades < 30) assert.equal(x.verdict, 'Insufficient trades');
  }
  const a = r.body.results.find((x) => x.skip === 0), b = r.body.results.find((x) => x.skip === 1000 && x.symbol === a.symbol && x.interval === a.interval && x.strategy === a.strategy);
  assert.ok(b.endTime <= a.startTime, 'the prior period ends before the latest begins');
});

test('lab refuses oversized or invalid requests', async () => {
  assert.equal((await post('/api/lab/compare', { symbols: SYMBOLS, strategies: ['ema_cross', 'macd_cross', 'bb_reversion'], intervals: ['15m', '1h', '4h', '1d', '5m'], periods: [{ bars: 500 }] })).status, 400);
  assert.equal((await post('/api/lab/compare', { symbols: [], strategies: ['ema_cross'] })).status, 400);
  assert.equal((await post('/api/lab/compare', { symbols: ['BTCUSDT'], strategies: ['nope'] })).status, 400);
});

test('walk-forward route returns chronological folds', async () => {
  const r = await post('/api/lab/walkforward', { symbol: 'ETHUSDT', interval: '1h', strategy: 'ema_cross', bars: 1500, folds: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.folds.length, 3);
  assert.ok(r.body.verdict);
});
