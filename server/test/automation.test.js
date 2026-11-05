// Calendar, report and Autopilot logic. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyEvent, dropCoveredFomc, fredActual, FRED_SERIES, parseFairEconomy, parseFomc, parseRegulatory } from '../src/intel/calendar.js';
import { buildPdf, toLatin, wrapText } from '../src/intel/pdf.js';
import { forecastReview, marketRisks, marketSummary, rankBy, rankMovers, reportToItems, ruleBasedSummary, unusualVolume } from '../src/intel/reports.js';
import { CONDITIONS, dataQuality, defaultConditions, detectConditions, inQuietHours, ruleExplanation, validateSettings } from '../src/intel/autopilot.js';

// ---- calendar
test('events are classified from their published title', () => {
  assert.equal(classifyEvent('CPI m/m'), 'cpi');
  assert.equal(classifyEvent('Core PPI m/m'), 'ppi');
  assert.equal(classifyEvent('Non-Farm Employment Change'), 'employment');
  assert.equal(classifyEvent('Unemployment Rate'), 'employment');
  assert.equal(classifyEvent('Advance GDP q/q'), 'gdp');
  assert.equal(classifyEvent('Federal Funds Rate'), 'rate-decision');
  assert.equal(classifyEvent('Official Bank Rate'), 'rate-decision');
  assert.equal(classifyEvent('FOMC Press Conference'), 'central-bank');
  assert.equal(classifyEvent('Bank Holiday', 'Holiday'), 'holiday');
  assert.equal(classifyEvent('Building Permits'), 'other');
});

test('the weekly calendar copies values as published and adds nothing', () => {
  const [a, b] = parseFairEconomy([
    { title: 'CPI m/m', country: 'USD', date: '2026-11-12T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.2%' },
    { title: 'Speech', country: 'EUR', date: '2026-11-12T09:00:00-05:00', impact: 'Low', forecast: '', previous: '' },
    { title: 'No date', country: 'USD', date: 'soon', impact: 'High' },
    { country: 'USD', date: '2026-11-12T08:30:00-05:00' },
  ]);
  assert.equal(a.startsAt, '2026-11-12T13:30:00.000Z');
  assert.equal(a.forecast, '0.3%');
  assert.equal(a.previous, '0.2%');
  assert.equal(a.importance, 'high');
  assert.equal(a.country, 'United States');
  assert.equal(b.forecast, null);
  assert.equal(b.previous, null);
  assert.equal(parseFairEconomy('nonsense').length, 0);
  assert.equal(parseFairEconomy([{ title: 'x', country: 'USD', date: '2026-11-12T08:30:00-05:00', impact: 'High' }])[0].actual, undefined);
});

const FOMC_HTML = `<h4><a id="1">2026 FOMC Meetings</a></h4>
<div class="fomc-meeting__month col"><strong>January</strong></div><div class="fomc-meeting__date col">27-28</div>
<div class="fomc-meeting__month col"><strong>Apr/May</strong></div><div class="fomc-meeting__date col">28-1</div>
<div class="fomc-meeting__month col"><strong>September</strong></div><div class="fomc-meeting__date col">15-16*</div>
<div class="fomc-meeting__month col"><strong>March</strong></div><div class="fomc-meeting__date col">9 (notation vote)</div>`;

test('FOMC dates come from the Fed page, with no invented time', () => {
  const rows = parseFomc(FOMC_HTML);
  assert.deepEqual(rows.map((r) => r.eventDate), ['2026-01-28', '2026-05-01', '2026-09-16']);
  assert.ok(rows.every((r) => r.startsAt === null));
  assert.match(rows[2].title, /projections/);
  assert.equal(parseFomc('<html>changed layout</html>').length, 0);
});

test('regulators are filtered to crypto items, and every item links to its source', () => {
  const xml = `<rss><channel>
    <item><title>SEC charges a crypto platform</title><link>https://www.sec.gov/a</link><pubDate>Mon, 02 Nov 2026 14:00:00 GMT</pubDate><description>x</description></item>
    <item><title>SEC adopts small entity rule</title><link>https://www.sec.gov/b</link><pubDate>Mon, 02 Nov 2026 15:00:00 GMT</pubDate><description>y</description></item>
  </channel></rss>`;
  const rows = parseRegulatory(xml, { source: 'SEC', cryptoOnly: true, category: 'regulatory' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceUrl, 'https://www.sec.gov/a');
  assert.equal(parseRegulatory(xml, { source: 'Fed', cryptoOnly: false, category: 'central-bank' }).length, 2);
});

test('actual values are computed from FRED only when the data is there', () => {
  const spec = (t) => FRED_SERIES.find((s) => s.test.test(t));
  const obs = (...v) => v.map((value) => ({ value: String(value) }));
  assert.equal(fredActual(spec('CPI m/m'), obs(101, 100)), '1.0%');
  assert.equal(fredActual(spec('Unemployment Rate'), obs(4.1)), '4.10%');
  assert.equal(fredActual(spec('Non-Farm Employment Change'), obs(158200, 158000)), '200K');
  assert.equal(fredActual(spec('CPI m/m'), obs(101)), null);
  assert.equal(fredActual(spec('Unemployment Rate'), [{ value: '.' }]), null);
  assert.equal(spec('Crude Oil Inventories'), undefined);
});

test('a dated Fed meeting gives way to the same decision with a published time', () => {
  const fed = { source: 'Federal Reserve', title: 'FOMC meeting ends', event_date: '2026-12-16' };
  const later = { source: 'Federal Reserve', title: 'FOMC meeting ends', event_date: '2027-01-27' };
  const ff = { source: 'ForexFactory', currency: 'USD', title: 'Federal Funds Rate', event_date: '2026-12-16' };
  assert.deepEqual(dropCoveredFomc([fed, later, ff]), [later, ff]);
});

// ---- PDF
test('the PDF writer produces a well-formed file with correct offsets', () => {
  const long = Array.from({ length: 400 }, (_, i) => ({ style: 'text', text: `Line ${i} with (brackets) and a back\\slash — and ₿` }));
  const buf = buildPdf([{ style: 'title', text: 'Test' }, ...long], { title: 'T', footer: 'Footer' });
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const pages = Number(s.match(/\/Type \/Pages \/Count (\d+)/)[1]);
  assert.ok(pages > 3);
  const xrefAt = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(xrefAt, xrefAt + 4), 'xref');
  // every object offset in the table points at that object
  const table = s.slice(xrefAt).split('\n').slice(3).filter((l) => / 00000 n /.test(l));
  table.forEach((row, i) => assert.ok(s.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.match(s, /\(Line 0 with \\\(brackets\\\) and a back\\\\slash - and \?\) Tj/);
});

test('PDF text handling', () => {
  assert.equal(toLatin('a–b ₿ ×'), 'a-b ? x');
  assert.ok(wrapText('word '.repeat(100), 10).length > 1);
  assert.ok(wrapText('x'.repeat(500), 10).every((l) => l.length <= 103));
});

// ---- report sections
const tick = (symbol, priceChangePercent, lastPrice = 100) => ({ symbol, priceChangePercent, lastPrice, quoteVolume: 1e9 });

test('market summary and movers use only what was returned', () => {
  const t = [tick('BTCUSDT', 2), tick('ETHUSDT', -1), tick('SOLUSDT', 5), tick('XRPUSDT', -4)];
  const m = marketSummary(t, [{ signal: 'BUY' }, { signal: 'BUY' }, { signal: 'HOLD' }]);
  assert.equal(m.data.advancers, 2);
  assert.equal(m.data.averageChangePct, 0.5);
  assert.deepEqual(m.data.signals, { BUY: 2, HOLD: 1 });
  assert.throws(() => marketSummary([], []), /No tickers/);
  const r = rankMovers(t);
  assert.deepEqual(r.gainers.map((x) => x.symbol), ['SOLUSDT', 'BTCUSDT']);
  assert.deepEqual(r.losers.map((x) => x.symbol), ['XRPUSDT', 'ETHUSDT']);
  assert.deepEqual(rankMovers([tick('BTCUSDT', 1)]).losers, []); // a rising coin is never listed as a loser
});

test('volume and rankings skip missing readings', () => {
  const o = [{ symbol: 'BTCUSDT', relativeVolume: 3, momentumPct: -9 }, { symbol: 'ETHUSDT', relativeVolume: 1, momentumPct: 2 }, { symbol: 'SOLUSDT', relativeVolume: null, momentumPct: null }];
  assert.deepEqual(unusualVolume(o).map((x) => x.symbol), ['BTCUSDT']);
  assert.deepEqual(rankBy(o, 'momentumPct').map((x) => x.symbol), ['BTCUSDT', 'ETHUSDT']);
});

test('risks come from the data', () => {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const risks = marketRisks({
    now,
    overview: [{ symbol: 'BTCUSDT', rsi: 75, volatilityPct: 1 }, { symbol: 'ETHUSDT', rsi: 25, volatilityPct: 3 }],
    events: [{ title: 'CPI m/m', currency: 'USD', starts_at: '2026-11-05T12:00:00Z' }, { title: 'Far', currency: 'USD', starts_at: '2026-11-20T12:00:00Z' }],
    futures: [{ symbol: 'BTCUSDT', fundingRatePct: 0.1 }, { symbol: 'ETHUSDT', fundingRatePct: 0.01 }],
  }).join(' ');
  assert.match(risks, /at or above 70.*BTC/);
  assert.match(risks, /at or below 30.*ETH/);
  assert.match(risks, /1 high-importance economic event is/);
  assert.match(risks, /funding is elevated: BTC/);
  assert.doesNotMatch(risks, /Far/);
  assert.deepEqual(marketRisks({}), []);
});

test('no accuracy is claimed until enough forecasts are scored', () => {
  const few = forecastReview({ saved: 10, pending: 5, minimumForJudgement: 50, overall: { n: 5, accuracy: 1, directionalCalls: 5 } });
  assert.equal(few.data.accuracy, null);
  assert.doesNotMatch(few.lines.join(' '), /100/);
  const many = forecastReview({ saved: 100, pending: 0, minimumForJudgement: 50, overall: { n: 60, accuracy: 0.55, directionalCalls: 40, baseRateUp: 0.5, brier: 0.24 } });
  assert.equal(many.data.accuracy, 0.55);
  assert.match(many.lines.join(' '), /55\.0%/);
  assert.equal(forecastReview(null).data.scored, 0);
  const now = Date.parse('2026-11-05T12:00:00Z');
  const scored = { saved: 100, pending: 0, minimumForJudgement: 50, overall: { n: 60, accuracy: 0.7, directionalCalls: 40 } };
  assert.match(forecastReview({ ...scored, first_saved: '2026-11-05T06:00:00Z' }, now).lines.join(' '), /only part of a day.*says little about long-run accuracy/);
  assert.match(forecastReview({ ...scored, first_saved: '2026-11-01T00:00:00Z' }, now).lines.join(' '), /only 5 days/);
  assert.doesNotMatch(forecastReview({ ...scored, first_saved: '2026-01-01T00:00:00Z' }, now).lines.join(' '), /says little/);
});

test('every report section in the PDF text has a timestamp and a source, and gaps are stated', () => {
  const report = {
    title: 'R', generated_at: '2026-11-05T01:00:00Z', report_date: '2026-11-05', ai_summary: null,
    content: {
      disclaimer: 'D', ruleSummary: 'Rules.',
      sections: [
        { id: 'market', title: 'Market', asOf: 1762300000000, source: { name: 'Binance', url: 'https://b' }, lines: ['One'] },
        { id: 'news', title: 'News', asOf: 1762300000000, source: { name: 'RSS' }, unavailable: 'Feeds failed' },
      ],
    },
  };
  const items = reportToItems(report);
  const meta = items.filter((i) => i.style === 'meta' && /Source:/.test(i.text));
  assert.equal(meta.length, 2);
  assert.match(items.map((i) => i.text).join('\n'), /Unavailable: Feeds failed/);
  assert.match(items.map((i) => i.text).join('\n'), /rule-based, not AI/);
  assert.match(ruleBasedSummary(report.content.sections), /Not available in this report: News/);
});

// ---- autopilot
const HOUR = 3600e3;
const series = (closes, volumes) => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  return closes.map((close, i) => ({ openTime: start + i * HOUR, closeTime: start + (i + 1) * HOUR - 1, open: i ? closes[i - 1] : close, high: Math.max(close, i ? closes[i - 1] : close) * 1.001, low: Math.min(close, i ? closes[i - 1] : close) * 0.999, close, volume: volumes?.[i] ?? 100, quoteVolume: 100 * close }));
};
const wiggle = (n, base = 100) => Array.from({ length: n }, (_, i) => base * (1 + 0.002 * Math.sin(i / 2) + 0.001 * Math.sin(i * 1.7)));
const only = (name, threshold) => ({ ...Object.fromEntries(Object.keys(CONDITIONS).map((k) => [k, { enabled: false }])), [name]: { enabled: true, threshold: threshold ?? CONDITIONS[name].threshold } });

test('bad data is rejected before anything is detected', () => {
  const good = series(wiggle(300));
  const at = good.at(-1).closeTime + 1000;
  assert.deepEqual(dataQuality(good, '1h', at), []);
  assert.match(dataQuality(series(wiggle(50)), '1h', at)[0], /Only 50/);
  assert.match(dataQuality(good, '1h', at + 10 * HOUR).join(), /stale/);
  const gap = good.filter((_, i) => i !== 280);
  assert.match(dataQuality(gap, '1h', at).join(), /gap/);
  const broken = series(wiggle(300));
  broken[290].close = NaN;
  assert.match(dataQuality(broken, '1h', at).join(), /invalid/);
  assert.match(dataQuality([], '1h', at).join(), /Only 0/);
});

test('an unusual move is found, and normal candles find nothing', () => {
  const calm = series(wiggle(300));
  assert.deepEqual(detectConditions(calm, only('unusual_move')), []);
  const closes = wiggle(300);
  closes[299] = closes[298] * 1.05;
  const [hit] = detectConditions(series(closes), only('unusual_move'));
  assert.equal(hit.condition, 'unusual_move');
  assert.equal(hit.side, 'up');
  assert.ok(hit.evidence.zScore > 3);
});

test('volume fires when it starts, not on every later candle', () => {
  const vols = Array(300).fill(100);
  vols[299] = 1000;
  assert.equal(detectConditions(series(wiggle(300), vols), only('relative_volume'))[0].condition, 'relative_volume');
  const held = Array(300).fill(100);
  held[298] = 1000;
  held[299] = 1000;
  assert.equal(detectConditions(series(wiggle(300), held), only('relative_volume')).length, 0);
});

test('an EMA cross is detected on the candle it happens', () => {
  const closes = [...Array.from({ length: 250 }, (_, i) => 200 - i * 0.4)];
  let found = null;
  for (let i = 0; i < 400 && !found; i++) {
    closes.push(closes.at(-1) * 1.012);
    found = detectConditions(series(closes), only('ema_cross'))[0];
  }
  assert.equal(found.side, 'up');
  assert.ok(found.evidence.ema50 > found.evidence.ema200);
});

test('a disabled condition never fires', () => {
  const closes = wiggle(300);
  closes[299] = closes[298] * 1.2;
  const none = Object.fromEntries(Object.keys(CONDITIONS).map((k) => [k, { enabled: false }]));
  assert.deepEqual(detectConditions(series(closes), none), []);
  assert.ok(detectConditions(series(closes), defaultConditions()).length > 0);
});

test('quiet hours handle midnight and time zones', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(inQuietHours('22:00', '07:00', 'UTC', at('2026-11-05T23:30:00Z')), true);
  assert.equal(inQuietHours('22:00', '07:00', 'UTC', at('2026-11-05T06:59:00Z')), true);
  assert.equal(inQuietHours('22:00', '07:00', 'UTC', at('2026-11-05T07:00:00Z')), false);
  assert.equal(inQuietHours('09:00', '17:00', 'UTC', at('2026-11-05T12:00:00Z')), true);
  assert.equal(inQuietHours('09:00', '17:00', 'UTC', at('2026-11-05T17:00:00Z')), false);
  assert.equal(inQuietHours('22:00', '07:00', 'Asia/Kolkata', at('2026-11-05T17:00:00Z')), true); // 22:30 there
  assert.equal(inQuietHours(null, null, 'UTC'), false);
  assert.equal(inQuietHours('10:00', '10:00', 'UTC'), false);
});

test('settings are validated', () => {
  const isActive = (s) => s === 'BTCUSDT';
  assert.deepEqual(validateSettings({ symbols: ['BTCUSDT'], intervals: ['1h'] }, { isActive }), { symbols: ['BTCUSDT'], intervals: ['1h'] });
  for (const bad of [{ symbols: [] }, { symbols: ['EVIL'] }, { intervals: ['1m'] }, { intervals: ['9h'] }, { quietStart: '25:00' }, { quietTimeZone: 'Mars/Base' }, { conditions: { hack: { enabled: true } } }, { conditions: { relative_volume: { enabled: true, threshold: 999 } } }]) {
    assert.throws(() => validateSettings(bad, { isActive }), { status: 400 }, JSON.stringify(bad));
  }
  assert.equal(validateSettings({ enabled: 'yes' }, { isActive }).enabled, false); // only a real true turns it on
  assert.deepEqual(validateSettings({ evil: 'x; DROP TABLE' }, { isActive }), {});
});

test('explanations say no action was taken', () => {
  const text = ruleExplanation({ message: 'Volume jumped.' }, { forecast: { horizon: '24h', probabilityUp: 0.6, hasMeasuredEdge: false }, headlines: [{ title: 'Big news' }], events: [{ title: 'CPI', event_date: '2026-11-12' }] });
  assert.match(text, /Volume jumped/);
  assert.match(text, /no measured edge/);
  assert.match(text, /Big news/);
  assert.match(text, /CPI/);
  assert.match(text, /takes no action/);
});

test('Autopilot has no route to trading in its code', async () => {
  const src = await readFile(new URL('../src/intel/autopilot.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '.*paper/);
  assert.doesNotMatch(src, /\bpaper\.\w+\(/);
  assert.doesNotMatch(src, /paper-order|\/api\/paper|paper_trades|paper_positions|paper_accounts/);
  assert.doesNotMatch(src, /^.*(INSERT INTO|UPDATE|DELETE FROM) (?!autopilot_)\w+/m);
  const routes = await readFile(new URL('../src/intel/routes-automation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(routes.match(/createAutopilot\(\{[^}]*\}\)/)[0], /paper/);
});
