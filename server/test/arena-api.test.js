// The Community Arena end to end: real app + PostgreSQL + the fake Binance.
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
let mock, server, base, pool, stream, otherProfile, otherStrategy, strategy, published;

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS arena_moderation_log, arena_reports, arena_favourites, arena_follows, arena_ratings, arena_comments, arena_verified_trades, arena_strategies, arena_profiles, strategy_orders, journal_annotations, strategies CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  const rest = createBinanceRest({ baseUrl: mock.rest });
  const made = createApp({ pool, rest, stream, futuresRest: rest, bookFeed: { subscribe: async () => () => {} }, liquidationFeed: { start() {}, stop() {}, purge: async () => {} }, fetchImpl: async () => new Response('', { status: 500 }) });
  server = http.createServer(made.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { stream?.stop(); server?.closeAllConnections?.(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, b) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
const post = (p, b) => send('POST', p, b);
const put = (p, b) => send('PUT', p, b);
const accountState = async () => (await pool.query(`SELECT (SELECT cash::text FROM paper_accounts WHERE id=1) c, (SELECT count(*)::int FROM paper_trades) t, (SELECT coalesce(string_agg(symbol||qty::text, ','), '') FROM paper_positions) p`)).rows[0];

const goodConfig = (o = {}) => ({
  name: 'RSI swing', symbol: 'BTCUSDT', interval: '1h', stopLossPct: 5, takeProfitPct: 10, positionPct: 25,
  entry: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '<', right: { kind: 'value', value: 45 } }] },
  exit: { logic: 'OR', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '>', right: { kind: 'value', value: 55 } }] },
  ...o,
});
const approvedStrategy = async (o) => {
  const { body: s } = await post('/api/strategies', { config: goodConfig(o) });
  await post(`/api/strategies/${s.id}/approve`);
  return s;
};
const publishBody = (o = {}) => ({ strategyId: strategy.id, category: 'mean-reversion', description: 'Buys weakness and sells recovery.', confirmed: true, ...o });

test('the Arena starts empty, with no invented entries, and says it is local', async () => {
  const { body } = await get('/api/arena/me');
  assert.equal(body.profile, null);
  assert.match(body.notice, /no user accounts/);
  const board = (await get('/api/arena/leaderboard')).body;
  assert.deepEqual(board.ranked, []);
  assert.deepEqual(board.unranked, []);
  assert.equal((await get('/api/arena/leaderboard?basis=hype')).status, 400);
});

test('profiles are validated and sanitized', async () => {
  assert.equal((await put('/api/arena/me', { handle: 'x' })).status, 400);
  assert.equal((await put('/api/arena/me', { handle: '<b>bad</b>' })).status, 400);
  const ok = await put('/api/arena/me', { handle: 'local_trader', bio: '<script>x</script>Hi there' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bio, 'xHi there');
  const second = await put('/api/arena/me', { handle: 'renamed_trader', bio: 'Hi' });
  assert.equal(second.body.id, ok.body.id); // still the one local profile
  await put('/api/arena/me', { handle: 'local_trader', bio: 'Hi' });
  // a second person, as accounts would create one
  otherProfile = (await pool.query(`INSERT INTO arena_profiles (handle, bio) VALUES ('other_person', 'bio') RETURNING id`)).rows[0].id;
  assert.equal((await put('/api/arena/me', { handle: 'OTHER_person' })).status, 409);
});

test('publishing needs approval and confirmation, and submitted figures are ignored', async () => {
  const { body: draft } = await post('/api/strategies', { config: goodConfig({ symbol: 'ETHUSDT' }) });
  assert.equal((await post('/api/arena/publish', { strategyId: draft.id, category: 'trend', description: 'A long enough text', confirmed: true })).status, 409);
  strategy = await approvedStrategy();
  assert.equal((await post('/api/arena/publish', publishBody({ confirmed: false }))).status, 400);
  assert.equal((await post('/api/arena/publish', publishBody({ category: 'magic' }))).status, 400);
  assert.equal((await post('/api/arena/publish', publishBody({ description: 'short' }))).status, 400);
  assert.equal((await post('/api/arena/publish', publishBody({ strategyId: 999999 }))).status, 404);

  const fake = { totalReturnPct: 99999, sharpe: 99, maxDrawdownPct: 0, trades: 9999 };
  const { status, body } = await post('/api/arena/publish', publishBody({ description: '<img src=x onerror=alert(1)>Buys weakness and sells recovery.', metrics: fake, backtest: { metrics: fake }, paper: { completedTrades: 500 }, riskRating: 'Low', profile_id: otherProfile, sharePaper: false }));
  assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
  published = body;
  assert.equal(body.description, 'Buys weakness and sells recovery.');
  assert.notEqual(body.backtest.metrics.totalReturnPct, 99999);
  assert.notEqual(body.backtest.metrics.trades, 9999);
  assert.equal(body.profile.handle, 'local_trader');
  assert.equal(body.paper, null);
  assert.equal(body.paperShared, false);
  assert.ok(body.backtest.computedAt);
  assert.ok(['Low', 'Medium', 'High'].includes(body.riskRating));
});

test('the same rules cannot be published twice, even under another name', async () => {
  assert.equal((await post('/api/arena/publish', publishBody())).status, 409);
  const renamed = await approvedStrategy({ name: 'Different name' });
  const r = await post('/api/arena/publish', publishBody({ strategyId: renamed.id }));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already published/);
});

const scanPrivate = (value) => {
  const text = JSON.stringify(value);
  for (const banned of ['"cash"', '"qty"', '"notional"', '"cost_basis"', '"avg_price"', '"fill_price"', '"realized_pnl"', '"trade_id"', '"source_text"', '"sourceText"', '"strategy_id"', '"is_local"']) assert.ok(!text.includes(banned), `${banned} leaked`);
};

test('verified paper results need opt-in, count only strategy orders, and never expose the account', async () => {
  await post('/api/paper/reset'); // the test database's account only
  const before = await accountState();
  // a trade placed before sharing is on, then a manual trade, then a journal link: none of them may count
  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'BUY', amountUsd: 100, confirmed: true });
  const manual = (await post('/api/paper/order', { symbol: 'ETHUSDT', side: 'BUY', amountUsd: 100 })).body;
  let d = (await get(`/api/arena/strategies/${published.id}`)).body;
  assert.equal(d.paper, null); // not shared
  scanPrivate(d);

  await send('PATCH', `/api/arena/strategies/${published.id}`, { sharePaper: true });
  await send('PUT', `/api/journal/trades/${manual.id}/annotation`, { strategyId: strategy.id, note: 'attaching this afterwards must not verify it' });
  d = (await get(`/api/arena/strategies/${published.id}`)).body;
  assert.equal(d.paperShared, true);
  assert.equal(d.paper, null); // nothing since sharing began

  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true });
  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'BUY', amountUsd: 200, confirmed: true });
  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true });
  d = (await get(`/api/arena/strategies/${published.id}`)).body;
  assert.equal(d.paper.completedTrades, 1); // the first sell closed a position opened before sharing began
  assert.ok(Math.abs(d.paper.totalReturnPct) < 2, `one quick round trip costs about fees: ${d.paper.totalReturnPct}`);
  scanPrivate(d);
  scanPrivate((await get('/api/arena/leaderboard?basis=paper')).body);
  scanPrivate((await get(`/api/arena/profiles/${published.profile.id}`)).body);

  // reading again never adds a duplicate record
  await get(`/api/arena/strategies/${published.id}`);
  const { rows: [{ n, u }] } = await pool.query('SELECT count(*)::int n, count(DISTINCT trade_id)::int u FROM arena_verified_trades');
  assert.equal(n, u);
  assert.equal(n, 2);
  assert.notEqual((await accountState()).t, before.t);
});

test('a trade made under changed rules is not credited to the published version', async () => {
  const n = async () => (await pool.query('SELECT count(*)::int n FROM arena_verified_trades')).rows[0].n;
  const had = await n();
  await put(`/api/strategies/${strategy.id}`, { config: goodConfig({ positionPct: 30 }) });
  await post(`/api/strategies/${strategy.id}/approve`);
  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'BUY', amountUsd: 50, confirmed: true });
  await post(`/api/strategies/${strategy.id}/paper-order`, { side: 'SELL', closeAll: true, confirmed: true });
  await get(`/api/arena/strategies/${published.id}`);
  assert.equal(await n(), had);
});

test('the verified record survives a paper account reset, and sharing can be withdrawn', async () => {
  const had = (await get(`/api/arena/strategies/${published.id}`)).body.paper.completedTrades;
  await post('/api/paper/reset');
  assert.equal((await get(`/api/arena/strategies/${published.id}`)).body.paper.completedTrades, had);
  await send('PATCH', `/api/arena/strategies/${published.id}`, { sharePaper: false });
  const off = (await get(`/api/arena/strategies/${published.id}`)).body;
  assert.equal(off.paper, null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM arena_verified_trades WHERE arena_strategy_id=$1', [published.id])).rows[0].n, 0);
});

test('someone else\'s strategy can be rated, followed, saved and copied; your own cannot be rated', async () => {
  const conf = goodConfig({ symbol: 'SOLUSDT', name: 'Their strategy' });
  const inserted = await pool.query(
    `INSERT INTO arena_strategies (profile_id, name, description, category, config, config_hash, symbol, interval, risk_rating, backtest, backtest_at)
     VALUES ($1,'Their strategy','Someone else published this.','trend',$2,'hash-other','SOLUSDT','1h','Low',$3,now()) RETURNING id`,
    [otherProfile, conf, { metrics: { trades: 40, totalReturnPct: 12, maxDrawdownPct: 6, sharpe: 1.2 }, consistencyPct: 70 }]);
  otherStrategy = inserted.rows[0].id;

  assert.equal((await put(`/api/arena/strategies/${published.id}/rating`, { stars: 5 })).status, 409);
  assert.equal((await put(`/api/arena/strategies/${otherStrategy}/rating`, { stars: 9 })).status, 400);
  assert.equal((await put(`/api/arena/strategies/${otherStrategy}/rating`, { stars: 4 })).body.rating.average, 4);
  const changed = (await put(`/api/arena/strategies/${otherStrategy}/rating`, { stars: 2 })).body;
  assert.equal(changed.rating.average, 2);
  assert.equal(changed.rating.count, 1); // one person, one rating
  assert.equal(changed.myRating, 2);

  await put(`/api/arena/strategies/${otherStrategy}/favourite`);
  await put(`/api/arena/strategies/${otherStrategy}/favourite`);
  assert.deepEqual((await get('/api/arena/leaderboard?filter=favourites')).body.ranked.map((r) => r.id).map(String), [String(otherStrategy)]);
  await send('DELETE', `/api/arena/strategies/${otherStrategy}/favourite`);
  assert.equal((await get('/api/arena/leaderboard?filter=favourites')).body.ranked.length, 0);

  assert.equal((await put(`/api/arena/profiles/${published.profile.id}/follow`)).status, 409);
  await put(`/api/arena/profiles/${otherProfile}/follow`);
  await put(`/api/arena/profiles/${otherProfile}/follow`);
  const p = (await get(`/api/arena/profiles/${otherProfile}`)).body;
  assert.equal(p.followers, 1);
  assert.equal(p.isFollowing, true);
  assert.equal(p.strategies.length, 1);
  assert.equal((await get('/api/arena/leaderboard?filter=following')).body.ranked.length, 1);

  const copied = (await post(`/api/arena/strategies/${otherStrategy}/copy`)).body;
  assert.equal(copied.status, 'draft'); // needs the user's own review
  assert.equal((await post(`/api/strategies/${copied.id}/paper-order`, { side: 'BUY', amountUsd: 10, confirmed: true })).status, 409);

  // only the owner can change a strategy
  assert.equal((await send('PATCH', `/api/arena/strategies/${otherStrategy}`, { description: 'hijacked text here' })).status, 404);
  assert.equal((await post(`/api/arena/strategies/${otherStrategy}/withdraw`)).status, 404);
  assert.equal((await post(`/api/arena/strategies/${otherStrategy}/backtest`)).status, 404);
});

test('comments are sanitized, limited and de-duplicated', async () => {
  const r = await post(`/api/arena/strategies/${otherStrategy}/comments`, { body: '<b>Nice</b> <script>steal()</script>result' });
  assert.equal(r.status, 200);
  assert.equal(r.body.comments[0].body, 'Nice steal()result');
  assert.equal((await post(`/api/arena/strategies/${otherStrategy}/comments`, { body: '<b>Nice</b> <script>steal()</script>result' })).status, 409);
  assert.equal((await post(`/api/arena/strategies/${otherStrategy}/comments`, { body: '<i></i>' })).status, 400);
  assert.equal((await post('/api/arena/strategies/999999/comments', { body: 'hello there' })).status, 404);
  let last;
  for (let i = 0; i < 12; i++) last = await post(`/api/arena/strategies/${otherStrategy}/comments`, { body: `comment number ${i}` });
  assert.equal(last.status, 429);
  await pool.query('DELETE FROM arena_comments WHERE body LIKE $1', ['comment number%']);
});

test('reports, moderation and the log: content is hidden and never deleted', async () => {
  const { rows: [c] } = await pool.query('SELECT id FROM arena_comments ORDER BY id DESC LIMIT 1');
  assert.equal((await post('/api/arena/reports', { targetType: 'comment', targetId: c.id, reason: 'no' })).status, 400);
  assert.equal((await post('/api/arena/reports', { targetType: 'wallet', targetId: 1, reason: 'bad target type' })).status, 400);
  assert.equal((await post('/api/arena/reports', { targetType: 'comment', targetId: 999999, reason: 'nothing there' })).status, 404);
  assert.equal((await post('/api/arena/reports', { targetType: 'comment', targetId: c.id, reason: 'This is spam' })).status, 200);
  assert.equal((await post('/api/arena/reports', { targetType: 'comment', targetId: c.id, reason: 'This is spam' })).status, 409);
  assert.equal((await get('/api/arena/moderation')).body.reports[0].status, 'open');

  await post('/api/arena/moderation', { targetType: 'comment', targetId: c.id, hidden: true, reason: 'Spam' });
  assert.equal((await get(`/api/arena/strategies/${otherStrategy}`)).body.comments.length, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM arena_comments WHERE id=$1', [c.id])).rows[0].n, 1);
  const q = (await get('/api/arena/moderation')).body;
  assert.equal(q.reports[0].status, 'resolved');
  assert.equal(q.log[0].action, 'hidden');
  await post('/api/arena/moderation', { targetType: 'comment', targetId: c.id, hidden: false });
  assert.equal((await get(`/api/arena/strategies/${otherStrategy}`)).body.comments.length, 1);

  await post('/api/arena/moderation', { targetType: 'strategy', targetId: otherStrategy, hidden: true });
  const board = (await get('/api/arena/leaderboard')).body;
  assert.ok(![...board.ranked, ...board.unranked].some((r) => String(r.id) === String(otherStrategy)));
  assert.equal((await get(`/api/arena/strategies/${otherStrategy}`)).status, 404);
  await post('/api/arena/moderation', { targetType: 'strategy', targetId: otherStrategy, hidden: false });
});

test('the leaderboard filters, and backtests are labelled apart from paper', async () => {
  const all = (await get('/api/arena/leaderboard')).body;
  assert.ok(all.ranked.length + all.unranked.length >= 2);
  assert.equal(all.basis, 'backtest');
  const sol = (await get('/api/arena/leaderboard?symbol=SOLUSDT')).body;
  assert.ok([...sol.ranked, ...sol.unranked].every((r) => r.symbol === 'SOLUSDT'));
  const cat = (await get('/api/arena/leaderboard?category=trend')).body;
  assert.ok([...cat.ranked, ...cat.unranked].every((r) => r.category === 'trend'));
  const paper = (await get('/api/arena/leaderboard?basis=paper')).body;
  assert.equal(paper.ranked.length, 0); // nobody has 30 verified trades, whatever their backtest says
});

test('withdrawing removes it from the board and keeps the record; publishing again restores it', async () => {
  await post(`/api/arena/strategies/${published.id}/withdraw`);
  const board = (await get('/api/arena/leaderboard')).body;
  assert.ok(![...board.ranked, ...board.unranked].some((r) => String(r.id) === String(published.id)));
  assert.equal((await pool.query('SELECT status FROM arena_strategies WHERE id=$1', [published.id])).rows[0].status, 'withdrawn');
  const mine = (await get('/api/arena/me')).body.strategies;
  assert.equal(mine.find((s) => String(s.id) === String(published.id)).status, 'withdrawn');
  await put(`/api/strategies/${strategy.id}`, { config: goodConfig() });
  await post(`/api/strategies/${strategy.id}/approve`);
  const again = await post('/api/arena/publish', publishBody());
  assert.equal(again.status, 200);
  assert.equal(String(again.body.id), String(published.id));
});

test('bad ids are refused cleanly', async () => {
  assert.equal((await get('/api/arena/strategies/abc')).status, 404);
  assert.equal((await get('/api/arena/profiles/abc')).status, 404);
  assert.equal((await post('/api/arena/moderation/reports/999999/dismiss')).status, 404);
});
