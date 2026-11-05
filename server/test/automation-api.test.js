// Calendar, Reports and Autopilot end to end: real app + PostgreSQL + the fake Binance and fake calendar sources.
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
import { attachWs, createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { COINS } from '../src/coins.js';

const SYMBOLS = COINS.map((c) => c.symbol);
let mock, server, base, pool, stream, intel, rest;
const seen = { fred: [] };
const failing = new Set();

const day = (offset) => new Date(Date.now() + offset * 86400e3).toISOString().slice(0, 10);
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate><description>${i.desc || ''}</description></item>`).join('')}</channel></rss>`;

const fixtures = async (url) => {
  const u = String(url);
  for (const f of failing) if (u.includes(f)) return new Response('nope', { status: 503 });
  if (u.includes('ff_calendar')) {
    return new Response(JSON.stringify([
      { title: 'CPI m/m', country: 'USD', date: `${day(2)}T08:30:00-05:00`, impact: 'High', forecast: '0.3%', previous: '0.2%' },
      { title: 'Unemployment Rate', country: 'USD', date: `${day(-3)}T08:30:00-05:00`, impact: 'High', forecast: '4.3%', previous: '4.2%' },
      { title: 'Retail Sales', country: 'GBP', date: `${day(1)}T02:00:00-05:00`, impact: 'Low', forecast: '', previous: '' },
    ]));
  }
  if (u.includes('fomccalendars')) {
    const next = new Date(Date.now() + 20 * 86400e3);
    const month = next.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const d = next.getUTCDate();
    return new Response(`<h4><a>${next.getUTCFullYear()} FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>${month}</strong></div><div class="fomc-meeting__date">${d}</div>`);
  }
  if (u.includes('press_monetary')) return new Response(rss([{ title: 'Federal Reserve issues FOMC statement', link: 'https://www.federalreserve.gov/a', at: Date.now() - 86400e3 }]));
  if (u.includes('sec.gov')) return new Response(rss([{ title: 'SEC charges crypto platform', link: 'https://www.sec.gov/c', at: Date.now() - 86400e3 }, { title: 'Unrelated rule', link: 'https://www.sec.gov/d', at: Date.now() - 86400e3 }]));
  if (u.includes('cftc.gov')) return new Response(rss([]));
  if (u.includes('stlouisfed')) {
    seen.fred.push(u);
    return new Response(JSON.stringify({ observations: [{ value: '4.4' }] }));
  }
  // news feeds
  if (u.includes('coindesk') || u.includes('cointelegraph') || u.includes('decrypt')) return new Response(rss([{ title: 'Bitcoin rises on real fixture news', link: `https://news.test/${encodeURIComponent(u)}`, at: Date.now() - 3600e3, desc: 'BTC story' }]));
  return new Response('{}', { status: 503 });
};

before(async () => {
  if (!DB) return;
  config.anthropicKey = '';
  delete process.env.FRED_API_KEY;
  mock = await startMockBinance();
  const { createPool } = await import('../src/db.js');
  pool = createPool(process.env.TEST_DATABASE_URL);
  await pool.query('DROP TABLE IF EXISTS calendar_events, research_reports, autopilot_settings, autopilot_runs, autopilot_events, autopilot_audit CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  stream = createBinanceStream({ baseUrl: mock.ws, symbols: SYMBOLS });
  await stream.start();
  rest = createBinanceRest({ baseUrl: mock.rest });
  const made = createApp({ pool, rest, stream, futuresRest: rest, bookFeed: { subscribe: async () => () => {} }, liquidationFeed: { start() {}, stop() {}, purge: async () => {}, state: () => ({}), status: () => ({}) }, fetchImpl: fixtures });
  intel = made.intel;
  server = http.createServer(made.app);
  attachWs(server, stream, intel);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { stream?.stop(); server?.closeAllConnections?.(); server?.close(); mock?.close(); await pool?.end(); });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const send = async (method, p, b) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json() }; };
const post = (p, b) => send('POST', p, b);
const paperState = async () => (await pool.query(`SELECT (SELECT cash::text FROM paper_accounts WHERE id=1) c, (SELECT count(*)::int FROM paper_trades) t, (SELECT coalesce(string_agg(symbol||qty::text, ','), '') FROM paper_positions) p`)).rows[0];

// ---- calendar
test('calendar lists only sourced events, and says what is not connected', async () => {
  const { status, body } = await get(`/api/calendar?from=${day(-10)}&to=${day(30)}`);
  assert.equal(status, 200, JSON.stringify(body).slice(0, 200));
  const cpi = body.events.find((e) => e.title === 'CPI m/m');
  assert.equal(cpi.forecast, '0.3%');
  assert.equal(cpi.previous, '0.2%');
  assert.equal(cpi.actual, null);
  assert.ok(cpi.starts_at);
  assert.ok(cpi.source_url.startsWith('https://'));
  const fomc = body.events.find((e) => e.title.startsWith('FOMC meeting'));
  assert.equal(fomc.starts_at, null);
  assert.ok(body.events.some((e) => e.title === 'SEC charges crypto platform'));
  assert.ok(!body.events.some((e) => e.title === 'Unrelated rule'));
  assert.equal(body.notConnected[0].name, 'Major cryptocurrency events');
  assert.ok(body.sources.find((s) => s.name === 'FRED actuals').needsKey);
  assert.match(body.timezone, /UTC/);
});

test('calendar filters, range checks and a saved copy that does not duplicate', async () => {
  const high = await get(`/api/calendar?from=${day(-10)}&to=${day(30)}&importance=high`);
  assert.ok(high.body.events.every((e) => e.importance === 'high'));
  const cpi = await get(`/api/calendar?from=${day(-10)}&to=${day(30)}&category=cpi`);
  assert.ok(cpi.body.events.length >= 1 && cpi.body.events.every((e) => e.category === 'cpi'));
  assert.equal((await get('/api/calendar?from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await get('/api/calendar?from=2020-01-01&to=2026-01-01')).status, 400);
  const before = (await pool.query('SELECT count(*)::int n FROM calendar_events')).rows[0].n;
  await intel.calendar.sync();
  assert.equal((await pool.query('SELECT count(*)::int n FROM calendar_events')).rows[0].n, before);
});

test('a failed source is reported and saved events stay', async () => {
  failing.add('ff_calendar');
  const sources = await intel.calendar.sync();
  failing.clear();
  const ff = sources.find((s) => s.name.startsWith('ForexFactory'));
  assert.equal(ff.ok, false);
  assert.match(ff.detail, /503/);
  assert.ok((await intel.calendar.list({ from: day(-10), to: day(30), category: 'cpi' })).length >= 1);
  await intel.calendar.sync();
});

test('actual values appear only with a FRED key, and the key is never exposed', async () => {
  process.env.FRED_API_KEY = 'secret-test-key';
  try {
    const sources = await intel.calendar.sync();
    assert.ok(seen.fred.some((u) => u.includes('series_id=UNRATE')));
    const { rows: [row] } = await pool.query(`SELECT actual, actual_source FROM calendar_events WHERE title='Unemployment Rate'`);
    assert.equal(row.actual, '4.40%');
    assert.match(row.actual_source, /FRED UNRATE/);
    const { rows: [future] } = await pool.query(`SELECT actual FROM calendar_events WHERE title='CPI m/m'`);
    assert.equal(future.actual, null); // not released yet
    assert.ok(!JSON.stringify(sources).includes('secret-test-key'));
  } finally { delete process.env.FRED_API_KEY; }
});

test('event explanations are written background when AI is off, and are labelled', async () => {
  const { rows: [e] } = await pool.query(`SELECT id FROM calendar_events WHERE title='CPI m/m'`);
  const { body } = await post(`/api/calendar/${e.id}/explain`);
  assert.equal(body.mode, 'background');
  assert.match(body.text, /inflation/i);
  assert.match(body.note, /not a prediction/);
  assert.equal((await post('/api/calendar/99999999/explain')).status, 404);
  assert.equal((await post('/api/calendar/abc/explain')).status, 404);
});

// ---- reports
test('a daily report has all 14 sections, each with a time and a source', async () => {
  const { status, body: r } = await post('/api/reports/generate', { kind: 'daily' });
  assert.equal(status, 200, JSON.stringify(r).slice(0, 300));
  const ids = r.content.sections.map((s) => s.id);
  for (const id of ['market', 'coin-BTC', 'coin-ETH', 'coin-SOL', 'gainers', 'losers', 'volume', 'volatility', 'momentum', 'levels', 'news', 'events', 'risks', 'performance']) assert.ok(ids.includes(id), id);
  for (const s of r.content.sections) {
    assert.ok(s.asOf, `${s.id} has a time`);
    assert.ok(s.source?.name, `${s.id} has a source`);
  }
  const unavailable = r.content.sections.filter((s) => s.unavailable).map((s) => `${s.id}: ${s.unavailable}`);
  assert.deepEqual(unavailable.filter((u) => !u.startsWith('exchanges')), []);
  assert.equal(r.ai_summary, null);
  assert.ok(r.content.ruleSummary.length > 20);
  assert.ok(r.content.sections.find((s) => s.id === 'news').articles.length >= 1);
  assert.ok(r.content.sections.find((s) => s.id === 'events').events.some((e) => e.title === 'CPI m/m'));
  assert.match(r.content.disclaimer, /not financial advice/);
});

test('a broken data source marks its section and nothing is made up', async () => {
  failing.add('coindesk'); failing.add('cointelegraph'); failing.add('decrypt');
  try {
    const reports = (await import('../src/intel/reports.js')).createReports({
      pool, tickersNow: async () => ({ tickers: [], live: false }), overviewFor: async () => [], forecastFor: async () => ({ unavailable: 'x' }), historyFor: async () => [],
      tracker: { performance: async () => { throw new Error('tracker down'); } },
      news: { latest: async () => { throw new Error('No news feed could be read'); } },
      calendar: { upcoming: async () => { throw new Error('calendar down'); } },
      orderBook: { snapshot: async () => { throw new Error('book down'); } },
      futures: { overview: async () => { throw new Error('futures down'); } },
      exchanges: { compare: async () => { throw new Error('exchanges down'); } },
      liquidations: {}, isActive: () => true,
    });
    const r = await reports.generate({ kind: 'daily' });
    const by = Object.fromEntries(r.content.sections.map((s) => [s.id, s]));
    assert.match(by.market.unavailable, /No tickers/);
    assert.match(by.news.unavailable, /No news feed/);
    assert.match(by.events.unavailable, /calendar down/);
    assert.match(by.performance.unavailable, /tracker down/);
    assert.match(by['coin-BTC'].unavailable, /No market data/);
    assert.match(r.content.ruleSummary, /Not available in this report/);
    await pool.query('DELETE FROM research_reports WHERE id=$1', [r.id]);
  } finally { failing.clear(); }
});

test('coin reports, the archive and date ranges', async () => {
  const { status, body: c } = await post('/api/reports/generate', { kind: 'coin', symbol: 'ETHUSDT' });
  assert.equal(status, 200, JSON.stringify(c).slice(0, 300));
  assert.equal(c.symbol, 'ETHUSDT');
  assert.ok(c.content.sections.find((s) => s.id === 'coin-ETH').data);
  const liq = c.content.sections.find((s) => s.id === 'liquidations');
  assert.ok(liq.unavailable || /estimate/i.test(liq.lines[0]));
  assert.equal((await post('/api/reports/generate', { kind: 'coin' })).status, 400);
  assert.equal((await post('/api/reports/generate', { kind: 'weird' })).status, 400);
  const all = (await get('/api/reports')).body.reports;
  assert.ok(all.length >= 2);
  assert.ok(all.every((x) => x.content === undefined)); // the list stays light
  assert.deepEqual((await get('/api/reports?kind=coin&symbol=ETHUSDT')).body.reports.map((x) => x.id), [c.id]);
  assert.equal((await get(`/api/reports?from=${day(1)}`)).body.reports.length, 0);
  assert.ok((await get(`/api/reports?from=${day(-1)}&to=${day(1)}`)).body.reports.length >= 2);
  assert.equal((await get('/api/reports?from=nonsense')).status, 400);
  assert.equal((await get('/api/reports/99999999')).status, 404);
});

test('the daily job writes one report a day and replaces nothing', async () => {
  const count = async () => (await pool.query(`SELECT count(*)::int n FROM research_reports WHERE kind='daily'`)).rows[0].n;
  const n = await count();
  assert.equal(await intel.reports.ensureDaily(), null);
  assert.equal(await count(), n);
  await pool.query(`UPDATE research_reports SET report_date = report_date - 1 WHERE kind='daily'`);
  const made = await intel.reports.ensureDaily();
  assert.equal(made.trigger, 'schedule');
  assert.equal(await count(), n + 1);
  assert.equal(await intel.reports.ensureDaily(), null);
});

test('reports export as PDF', async () => {
  const { reports } = (await get('/api/reports?kind=daily')).body;
  const r = await fetch(`${base}/api/reports/${reports[0].id}/pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="signal-lab-daily-/);
  const s = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.match(s, /Executive summary \\\(rule-based, not AI\\\)/);
  assert.match(s, /Data as of/);
});

// ---- autopilot
const goodConfig = (o = {}) => ({
  name: 'Test', symbol: 'BTCUSDT', interval: '1h', positionPct: 10, stopLossPct: 5, takeProfitPct: 10,
  entry: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '<=', right: { kind: 'value', value: 100 } }] },
  exit: { logic: 'AND', conditions: [{ left: { kind: 'indicator', name: 'rsi14' }, op: '>=', right: { kind: 'value', value: 0 } }] },
  ...o,
});

test('Autopilot starts off, and the schedule does nothing until it is on', async () => {
  const { body } = await get('/api/autopilot/settings');
  assert.equal(body.settings.enabled, false);
  assert.deepEqual(body.settings.symbols, SYMBOLS);
  assert.match(body.mode, /never places orders/);
  assert.equal(await intel.autopilot.tick(), null);
  assert.equal((await get('/api/autopilot/runs')).body.length, 0);
});

test('settings are validated, saved and audited; pause stops the schedule', async () => {
  assert.equal((await send('PUT', '/api/autopilot/settings', { symbols: ['EVIL'] })).status, 400);
  const ok = await send('PUT', '/api/autopilot/settings', { enabled: true, symbols: ['BTCUSDT', 'ETHUSDT'], intervals: ['1h'], quietStart: '', quietEnd: '' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.enabled, true);
  await post('/api/autopilot/pause');
  assert.equal(await intel.autopilot.tick(), null);
  await post('/api/autopilot/resume');
  const audit = (await get('/api/autopilot/audit')).body.map((a) => a.action);
  assert.ok(audit.includes('settings_changed') && audit.includes('paused') && audit.includes('resumed'));
});

test('a run follows the full workflow, logs its steps, and never touches the paper account', async () => {
  const before = await paperState();
  const { status, body: run } = await post('/api/autopilot/run');
  assert.equal(status, 200, JSON.stringify(run).slice(0, 300));
  assert.deepEqual(run.steps.map((s) => s.name), ['Collect market data', 'Validate data quality', 'Check market conditions', 'Evaluate approved strategies', 'Research and save', 'Notify']);
  assert.equal(run.steps[3].ordersPlaced, 0);
  assert.ok(['ok', 'partial'].includes(run.status));
  assert.ok(run.finished_at);
  assert.match(run.summary, /Checked/);
  assert.deepEqual(await paperState(), before);
});

test('an approved strategy is checked, a draft is not, no order is placed, and repeats are skipped', async () => {
  const before = await paperState();
  const draft = (await post('/api/strategies', { config: goodConfig({ symbol: 'ETHUSDT', name: 'Draft' }) })).body;
  const approved = (await post('/api/strategies', { config: goodConfig({ name: 'Approved' }) })).body;
  await post(`/api/strategies/${approved.id}/approve`);
  const first = (await post('/api/autopilot/run')).body;
  assert.ok(first.events_new >= 1, JSON.stringify(first));
  const events = (await get('/api/autopilot/events?limit=200')).body.events.filter((e) => e.condition === 'strategy_signal');
  assert.ok(events.some((e) => e.evidence.strategyId === approved.id));
  assert.ok(!events.some((e) => e.evidence.strategyId === draft.id));
  assert.ok(events.every((e) => /No order was placed/.test(e.message)));
  assert.ok(events.every((e) => e.explanation_mode === 'rules' && /takes no action/.test(e.explanation)));

  const second = (await post('/api/autopilot/run')).body;
  assert.equal(second.events_new, 0);
  assert.ok(second.events_duplicate >= 1);
  const { rows: [{ n, u }] } = await pool.query('SELECT count(*)::int n, count(DISTINCT dedupe_key)::int u FROM autopilot_events');
  assert.equal(n, u);
  assert.deepEqual(await paperState(), before);
});

test('notifications reach Lab subscribers only, and quiet hours save without notifying', async () => {
  await pool.query('DELETE FROM autopilot_events');
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const got = [];
  ws.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.type === 'autopilot') got.push(m.data); });
  const plain = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const plainGot = [];
  plain.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.type === 'autopilot') plainGot.push(m.data); });
  await Promise.all([new Promise((r) => ws.on('open', r)), new Promise((r) => plain.on('open', r))]);
  ws.send(JSON.stringify({ type: 'alerts' }));
  await new Promise((r) => setTimeout(r, 100));
  try {
    // a quiet window that always covers now
    const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
    await send('PUT', '/api/autopilot/settings', { quietStart: hhmm(Date.now() - 3600e3), quietEnd: hhmm(Date.now() + 3600e3), quietTimeZone: 'UTC', notify: true });
    const quiet = (await post('/api/autopilot/run')).body;
    assert.ok(quiet.events_new >= 1);
    assert.equal(quiet.steps.at(-1).quietHours, true);
    assert.equal(quiet.steps.at(-1).notified, 0);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(got.length, 0);
    const saved = (await get('/api/autopilot/events?limit=200')).body;
    assert.ok(saved.events.every((e) => e.suppressed_quiet && !e.notified));
    assert.ok(saved.unread >= 1);
    await post('/api/autopilot/events/read');
    assert.equal((await get('/api/autopilot/events')).body.unread, 0);

    await pool.query('DELETE FROM autopilot_events');
    await send('PUT', '/api/autopilot/settings', { quietStart: '', quietEnd: '' });
    const loud = (await post('/api/autopilot/run')).body;
    assert.ok(loud.steps.at(-1).notified >= 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.length, loud.steps.at(-1).notified);
    assert.equal(plainGot.length, 0);
  } finally { ws.close(); plain.close(); }
});

test('a data failure is logged as a failed run and the job survives', async () => {
  const { createAutopilot } = await import('../src/intel/autopilot.js');
  const pilot = createAutopilot({
    pool, markets: { active: () => ['BTCUSDT'], isActive: () => true },
    historyFor: async () => { throw new Error('Binance is down'); },
    tickersNow: async () => { throw new Error('Binance is down'); },
    forecastFor: async () => { throw new Error('Binance is down'); },
    news: { latest: async () => [] }, calendar: { upcoming: async () => [] },
  });
  await pool.query(`UPDATE autopilot_settings SET symbols=ARRAY['BTCUSDT']`);
  const run = await pilot.runOnce('manual');
  assert.equal(run.status, 'failed');
  assert.match(run.errors.join(), /Binance is down/);
  assert.equal(run.events_new, 0);
});

test('two runs at once share one run', async () => {
  const [a, b] = await Promise.all([post('/api/autopilot/run'), post('/api/autopilot/run')]);
  assert.equal(a.body.id, b.body.id);
});
