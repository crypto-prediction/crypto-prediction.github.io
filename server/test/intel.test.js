// Pure logic of the intelligence features. No database or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLogistic, forecast, HORIZONS, MIN_INDEPENDENT, supportResistance } from '../src/intel/forecast.js';
import { calibration, createTracker, score, scoreBreakdown } from '../src/intel/tracker.js';
import { marketBrief, ruleBasedAnswer } from '../src/intel/intelligence.js';
import { checkRule, validateRule } from '../src/intel/alerts.js';
import { analyzePortfolio, correlation, maxDrawdown } from '../src/intel/portfolio.js';
import { largeBtcTransfers, suddenMoves, summarizeBook } from '../src/intel/activity.js';
import { createNews, interpret, parseRss, tagCoins } from '../src/intel/news.js';
import { assess, paramGrid, runWalkForward } from '../src/intel/lab.js';
import { aiComplete, aiStatus } from '../src/ai.js';
import { config } from '../src/config.js';

// deterministic price path built from waves
function candles(n, { base = 100, ms = 3600e3, start = 1_700_000_000_000 } = {}) {
  const out = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const c = base * (1 + 0.05 * Math.sin(i / 17) + 0.02 * Math.sin(i / 5.3) + 0.008 * Math.cos(i / 1.7));
    const v = 100 + 40 * Math.abs(Math.sin(i / 9));
    out.push({ openTime: start + i * ms, closeTime: start + (i + 1) * ms - 1, open: prev, high: Math.max(prev, c) * 1.002, low: Math.min(prev, c) * 0.998, close: c, volume: v, quoteVolume: v * c, trades: 500 + i % 50, takerBuyVolume: v * 0.5, closed: true });
    prev = c;
  }
  return out;
}

// ---- forecasting
test('logistic regression learns a clear pattern and stays a probability', () => {
  const X = [], y = [];
  for (let i = 0; i < 400; i++) { const v = (i % 40) - 20; X.push([v, 1]); y.push(v > 0 ? 1 : 0); }
  const m = fitLogistic(X, y);
  assert.ok(m.predict([15, 1]) > 0.8);
  assert.ok(m.predict([-15, 1]) < 0.2);
  for (const row of X) { const p = m.predict(row); assert.ok(p > 0 && p < 1); }
});

test('forecast contains every requested field, for each horizon', () => {
  const data = candles(1500);
  for (const h of Object.keys(HORIZONS)) {
    const f = forecast(data, h);
    assert.ok(!f.unavailable, f.unavailable);
    assert.ok(['Up', 'Down', 'Sideways'].includes(f.direction));
    assert.ok(Math.abs(f.probabilityUp + f.probabilityDown - 1) < 1e-12);
    assert.ok(f.range.low < f.price && f.price < f.range.high, h);
    assert.ok(f.expectedVolatilityPct > 0);
    assert.ok(['Low', 'Medium', 'High'].includes(f.confidence));
    assert.ok(['Low', 'Medium', 'High'].includes(f.riskLevel));
    assert.equal(f.reasons.length, 4);
    assert.equal(f.modelType, 'statistical');
    assert.equal(f.asOfClose, data[1499].closeTime);
  }
});

test('forecast has no look-ahead: later candles do not change it, and the forming candle is ignored', () => {
  const data = candles(900);
  const before = forecast(data, '4h');
  const withForming = [...data, { ...data[899], openTime: data[899].openTime + 3600e3, close: 99999, high: 99999, closed: false }];
  const after = forecast(withForming, '4h');
  assert.equal(before.probabilityUp, after.probabilityUp);
  assert.deepEqual(before.range, after.range);
  // a label needs its outcome to have closed: the last h candles are never training targets
  assert.equal(before.trainingRows, 900 - 210 - HORIZONS['4h'].bars);
});

test('forecast is deterministic: the same candles give the same numbers', () => {
  const data = candles(800);
  assert.equal(forecast(data, '1h').probabilityUp, forecast(data, '1h').probabilityUp);
});

test('forecast refuses to guess with too little history', () => {
  const f = forecast(candles(200), '1h');
  assert.match(f.unavailable, /Needs \d+ closed/);
  assert.throws(() => forecast(candles(500), '3d'), /Unknown horizon/);
});

test('confidence stays Low when the holdout shows no edge', () => {
  // a random-looking but fixed walk: nothing a model should be able to predict
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const data = candles(900);
  let p = 100;
  for (const c of data) { c.open = p; p *= 1 + (rand() - 0.5) * 0.01; c.close = p; c.high = Math.max(c.open, p) * 1.001; c.low = Math.min(c.open, p) * 0.999; c.volume = 100 + rand() * 50; }
  const f = forecast(data, '1h');
  if (!f.hasMeasuredEdge) assert.equal(f.confidence, 'Low');
  assert.ok(f.holdout.accuracy > 0.3 && f.holdout.accuracy < 0.7, 'no impossible accuracy on noise');
  assert.ok(Math.abs(f.probabilityUp - f.baseRateUp) < 0.15, 'noise gives a probability near the base rate, not an extreme one');
});

test('no edge is claimed from too few independent test periods, however good it looks', () => {
  const f = forecast(candles(1000), '7d'); // 42-candle outcomes on 1,000 candles overlap heavily
  assert.ok(f.holdout === null || f.holdout.independentSamples < MIN_INDEPENDENT);
  assert.equal(f.hasMeasuredEdge, false);
  assert.equal(f.confidence, 'Low');
});

test('support and resistance are real swing levels on the correct side of price', () => {
  const data = candles(500);
  const price = data[499].close;
  const { support, resistance } = supportResistance(data, price);
  assert.ok(support < price && data.some((c) => c.low === support));
  assert.ok(resistance > price && data.some((c) => c.high === resistance));
});

// ---- tracker
test('the tracker fits no model when the latest closed candle already has a forecast', async () => {
  let fits = 0;
  const pool = { query: async () => ({ rows: [{}], rowCount: 0 }) };
  const t = createTracker({ pool, markets: { active: () => ['BTCUSDT'] }, forecastFor: async () => { fits++; return { unavailable: 'x' }; } });
  assert.equal(await t.record(), 0);
  assert.equal(fits, 0);
});

const row = (p, direction, up, extra = {}) => ({ probability_up: p, direction, outcome_up: up, in_range: true, ...extra });

test('scores match a hand calculation', () => {
  const rows = [row(0.7, 'Up', true), row(0.6, 'Up', false), row(0.3, 'Down', false), row(0.5, 'Sideways', true)];
  const s = score(rows);
  assert.equal(s.n, 4);
  assert.equal(s.directionalCalls, 3);
  assert.ok(Math.abs(s.accuracy - 2 / 3) < 1e-12, 'Sideways does not count as a call');
  assert.equal(s.precisionUp, 0.5); // 1 of 2 Up calls was right
  assert.equal(s.recallUp, 0.5); // 1 of the 2 real rises was called Up
  assert.ok(Math.abs(s.brier - (0.09 + 0.36 + 0.09 + 0.25) / 4) < 1e-12);
  assert.equal(s.baseRateUp, 0.5);
});

test('no scored forecasts means no numbers at all, never a default', () => {
  const s = score([]);
  assert.equal(s.n, 0);
  for (const k of ['accuracy', 'precisionUp', 'recallUp', 'brier', 'baseRateUp', 'rangeCoverage']) assert.equal(s[k], null);
  const b = scoreBreakdown([]);
  assert.deepEqual(b.byCoin, {});
  assert.ok(b.calibration.every((x) => x.n === 0 && x.observedUp === null));
});

test('calibration bins and market breakdown count correctly', () => {
  const rows = [row(0.1, 'Down', false), row(0.15, 'Down', true), row(0.9, 'Up', true)];
  const c = calibration(rows);
  assert.equal(c[0].n, 2);
  assert.equal(c[0].observedUp, 0.5);
  assert.equal(c[4].n, 1);
  assert.equal(c[4].observedUp, 1);
  const b = scoreBreakdown([row(0.6, 'Up', true, { regime: 'Uptrend', symbol: 'X', horizon: '1h' }), row(0.4, 'Down', true, { regime: 'Mixed', symbol: 'Y', horizon: '1h' })]);
  assert.equal(b.byMarket.Bullish.n, 1);
  assert.equal(b.byMarket.Sideways.n, 1);
  assert.equal(b.byHorizon['1h'].n, 2);
});

// ---- intelligence
const coin = (symbol, o = {}) => ({ symbol, trend: 'Mixed', rsi: 50, momentumPct: 0, relativeVolume: 1, volatilityPct: 1, macdHistogram: 1, macdState: 'Positive, rising', signal: 'HOLD', ...o });

test('market mood follows breadth, and unusual activity follows thresholds', () => {
  const coins = [coin('BTCUSDT', { trend: 'Uptrend', momentumPct: 3 }), coin('ETHUSDT', { trend: 'Uptrend', momentumPct: 5, relativeVolume: 3 }), coin('SOLUSDT', { trend: 'Uptrend', rsi: 75 }), coin('XRPUSDT')];
  const tickers = { BTCUSDT: { priceChangePercent: 2 }, ETHUSDT: { priceChangePercent: 9 } };
  const b = marketBrief({ coins, tickers });
  assert.equal(b.mood, 'Bullish');
  assert.equal(b.strongestMomentum[0].symbol, 'ETHUSDT');
  assert.equal(b.unusualActivity.length, 1);
  assert.match(b.unusualActivity[0].flags.join(), /volume 3\.0×/);
  assert.ok(b.risks.some((r) => /overbought.*SOL/.test(r)));
  assert.equal(marketBrief({ coins: coins.map((c) => ({ ...c, trend: 'Mixed' })), tickers }).mood, 'Neutral');
});

test('a coin that failed to load is left out rather than filled in', () => {
  const b = marketBrief({ coins: [coin('BTCUSDT'), { symbol: 'ETHUSDT', error: 'down' }] });
  assert.equal(b.breadth.total, 1);
});

test('rule-based answers use the readings and do not claim a cause', () => {
  const coins = [coin('BTCUSDT', { momentumPct: 4 }), coin('DOGEUSDT', { momentumPct: 1 })];
  const brief = marketBrief({ coins });
  const ctx = { coins, tickers: { BTCUSDT: { priceChangePercent: 1.5 } }, brief };
  const why = ruleBasedAnswer('Why is BTC moving?', ctx);
  assert.match(why, /Bitcoin is \+1\.50%/);
  assert.match(why, /can't show its cause/);
  assert.match(ruleBasedAnswer('strongest momentum?', ctx), /Bitcoin.*\+4\.00%/);
  assert.match(ruleBasedAnswer('is it bullish?', ctx), /Neutral/);
  assert.match(ruleBasedAnswer('tell me a joke', ctx), /only answer this from market readings/);
});

// ---- alerts
const rule = (type, params = {}) => ({ symbol: 'BTCUSDT', type, params });

test('each alert type checks its condition', () => {
  const snap = { price: 100, close: 100, rsi: 75, macdHistogram: 1, macdHistogramPrev: -1, relativeVolume: 3, high20: 90, low20: 80, volatilityPct: 5, momentumPct: 2 };
  assert.equal(checkRule(rule('price_above', { value: 90 }), snap).hit, true);
  assert.equal(checkRule(rule('price_above', { value: 110 }), snap).hit, false);
  assert.equal(checkRule(rule('price_below', { value: 110 }), snap).hit, true);
  assert.equal(checkRule(rule('rsi_overbought', {}), snap).hit, true);
  assert.equal(checkRule(rule('rsi_oversold', {}), snap).hit, false);
  assert.equal(checkRule(rule('macd_cross'), snap).hit, true);
  assert.equal(checkRule(rule('macd_cross'), { ...snap, macdHistogramPrev: 0.5 }).hit, false);
  assert.equal(checkRule(rule('unusual_volume', { value: 2 }), snap).hit, true);
  assert.equal(checkRule(rule('breakout'), snap).hit, true);
  assert.equal(checkRule(rule('support_breakdown'), snap).hit, false);
  assert.equal(checkRule(rule('support_breakdown'), { ...snap, close: 70 }).hit, true);
  assert.equal(checkRule(rule('high_volatility', { value: 2 }), snap).hit, true);
  assert.equal(checkRule(rule('custom', { metric: 'momentumPct', op: '>', value: 1 }), snap).hit, true);
  assert.equal(checkRule(rule('custom', { metric: 'momentumPct', op: '<=', value: 1 }), snap).hit, false);
});

test('a rule with no reading stays silent instead of firing', () => {
  assert.equal(checkRule(rule('price_above', { value: 1 }), { price: null }), null);
  assert.equal(checkRule(rule('rsi_overbought'), {}), null);
  assert.equal(checkRule(rule('custom', { metric: 'rsi', op: '>', value: 1 }), {}), null);
});

test('alert rules are validated', () => {
  const ok = (s) => s === 'BTCUSDT';
  assert.throws(() => validateRule({ symbol: 'NOPE', type: 'price_above' }, ok), /Unsupported symbol/);
  assert.throws(() => validateRule({ symbol: 'BTCUSDT', type: 'nope' }, ok), /Unknown alert type/);
  assert.throws(() => validateRule({ symbol: 'BTCUSDT', type: 'price_above' }, ok), /needs a value/);
  assert.throws(() => validateRule({ symbol: 'BTCUSDT', type: 'price_above', params: { value: 'abc' } }, ok), /number/);
  assert.throws(() => validateRule({ symbol: 'BTCUSDT', type: 'custom', params: { metric: 'evil', op: '>', value: 1 } }, ok), /Unknown metric/);
  assert.throws(() => validateRule({ symbol: 'BTCUSDT', type: 'custom', params: { metric: 'rsi', op: 'drop', value: 1 } }, ok), /comparison/);
  assert.equal(validateRule({ symbol: 'BTCUSDT', type: 'rsi_overbought' }, ok).params.value, 70);
});

// ---- portfolio
test('portfolio analysis adds up, and correlation and drawdown match hand calculations', () => {
  assert.ok(Math.abs(correlation([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.equal(maxDrawdown([100, 120, 90, 110]), 25);
  const pf = { equity: 10000, cash: 9500, marketValue: 500, realizedPnl: 0, feesPaid: 0.5, allPositionsPriced: true, positions: [{ symbol: 'BTCUSDT', marketValue: 500, unrealizedPnl: 2, realizedPnl: 0, feesPaid: 0.5 }] };
  const a = analyzePortfolio(pf, [{ equity: 10000 }, { equity: 9000 }], { BTCUSDT: [0.01, -0.01, 0.01], ETHUSDT: [0.02, -0.02, 0.02] }, 24);
  assert.equal(a.exposure[0].sharePct, 5);
  assert.equal(a.risk.investedPct, 5);
  assert.ok(Math.abs(a.risk.maxDrawdownPct - 10) < 1e-9);
  assert.equal(a.unrealizedPnl, 2);
  assert.deepEqual(a.correlation.held, ['BTCUSDT']);
  assert.equal(a.correlation.matrix[0][1], 1);
  assert.ok(a.risk.dailyVolatilityPct > 0);
});

test('an unpriced position leaves risk numbers unknown, not guessed', () => {
  const pf = { equity: null, cash: 100, marketValue: null, realizedPnl: 0, feesPaid: 0, allPositionsPriced: false, positions: [{ symbol: 'BTCUSDT', marketValue: null, unrealizedPnl: null, realizedPnl: 0, feesPaid: 0 }] };
  const a = analyzePortfolio(pf, [], {}, 24);
  assert.equal(a.unrealizedPnl, null);
  assert.equal(a.risk.dailyVolatilityPct, null);
  assert.equal(a.risk.investedPct, null);
  assert.equal(a.risk.maxDrawdownPct, null);
});

// ---- activity
test('order book summary is correct', () => {
  const s = summarizeBook({ bids: [['99', '10'], ['50', '100']], asks: [['101', '5'], ['200', '100']] });
  assert.equal(s.mid, 100);
  assert.equal(s.spreadBps, 200);
  assert.equal(s.bidDepthUsd, 990); // the 50 level is outside the 1% band
  assert.equal(s.askDepthUsd, 505);
  assert.ok(Math.abs(s.imbalance - (990 - 505) / (990 + 505)) < 1e-12);
  assert.equal(s.largestBid.price, 50);
  assert.equal(summarizeBook({ bids: [], asks: [] }), null);
});

test('sudden moves find a real outlier and nothing on a quiet series', () => {
  const data = candles(200);
  assert.equal(suddenMoves(data.map((c, i) => ({ ...c, close: 100 + (i % 2) * 0.1 }))).length, 0);
  const spiked = data.map((c, i) => ({ ...c, close: i === 199 ? 200 : 100 + (i % 2) * 0.1 }));
  const [m] = suddenMoves(spiked);
  assert.ok(m.movePct > 50);
});

test('BTC transfers are read from real fields only, and absent data gives none', () => {
  const big = largeBtcTransfers({ txs: [{ hash: 'a', time: 5, out: [{ value: 150e8 }, { value: 1e8 }] }, { hash: 'b', out: [{ value: 1e8 }] }] });
  assert.deepEqual(big, [{ hash: 'a', btc: 151, time: 5000 }]);
  assert.deepEqual(largeBtcTransfers(null), []);
});

// ---- news
const RSS = `<rss><channel>
<item><title><![CDATA[Solana surges as ETF wins approval]]></title><link>https://x.test/a</link><pubDate>Thu, 05 Nov 2026 08:35:37 +0000</pubDate><description><![CDATA[<p>SOL &amp; friends rally.</p>]]></description></item>
<item><title>No date here</title><link>https://x.test/b</link></item>
<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Thu, 05 Nov 2026 08:35:37 +0000</pubDate></item>
<item><title>Exchange hacked, click this link for details</title><link>https://x.test/c</link><pubDate>Wed, 04 Nov 2026 08:35:37 +0000</pubDate></item>
</channel></rss>`;

test('RSS parsing keeps real fields, strips markup, and skips incomplete or unsafe items', () => {
  const items = parseRss(RSS, 'Test');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Solana surges as ETF wins approval');
  assert.equal(items[0].summary, 'SOL & friends rally.');
  assert.equal(items[0].publishedAt, Date.parse('Thu, 05 Nov 2026 08:35:37 +0000'));
  assert.ok(items.every((i) => /^https:/.test(i.link)));
});

test('coin tagging avoids everyday words', () => {
  assert.deepEqual(tagCoins('Solana and BTC rally'), ['BTCUSDT', 'SOLUSDT']);
  assert.deepEqual(tagCoins('Click this link to sol ada'), []);
  assert.deepEqual(tagCoins('LINK jumps'), ['LINKUSDT']);
});

test('interpretation is labelled as an estimate', () => {
  const a = interpret('Solana surges as ETF wins approval');
  assert.equal(a.sentiment, 'Positive');
  assert.equal(a.impact, 'High');
  assert.match(a.method, /not verified and not AI/);
  assert.equal(interpret('Prices plunge after hack').sentiment, 'Negative');
});

test('news reports a failed feed and fails clearly when none can be read', async () => {
  const cached = (_k, _t, fn) => fn();
  const feeds = [{ source: 'Good', url: 'g' }, { source: 'Bad', url: 'b' }];
  const fetchImpl = async (u) => (u === 'g' ? new Response(RSS) : new Response('', { status: 500 }));
  const data = await createNews({ cached, fetchImpl, feeds }).latest();
  assert.equal(data.articles.length, 2);
  assert.equal(data.articles[0].published.source, 'Good');
  assert.equal(data.articles[0].interpretation.sentiment, 'Positive');
  assert.deepEqual(data.sources.map((s) => s.ok), [true, false]);
  const down = async () => new Response('', { status: 500 });
  await assert.rejects(createNews({ cached, fetchImpl: down, feeds }).latest(), /No news feed could be read/);
});

// ---- lab
test('the verdict never praises thin or failing evidence', () => {
  const m = (o = {}) => ({ trades: 50, totalReturnPct: 10, buyHoldReturnPct: 2, ...o });
  assert.equal(assess(m({ trades: 29, totalReturnPct: 500 })).verdict, 'Insufficient trades');
  assert.equal(assess(m(), { trades: 5, totalReturnPct: 9 }).verdict, 'Insufficient out-of-sample trades');
  assert.equal(assess(m(), { trades: 20, totalReturnPct: -1 }).verdict, 'Failed out of sample');
  assert.equal(assess(m({ buyHoldReturnPct: 20 }), { trades: 20, totalReturnPct: 1 }).verdict, 'Lags buy and hold');
  assert.equal(assess(m({ totalReturnPct: -5, buyHoldReturnPct: -20 }), { trades: 20, totalReturnPct: 1 }).verdict, 'Lost money', 'beating a falling coin is not a win');
  const wf = m({ totalReturnPct: -5, buyHoldReturnPct: -20 });
  assert.equal(assess(wf, wf).verdict, 'Failed out of sample', 'walk-forward results are all out of sample');
  const best = assess(m(), { trades: 20, totalReturnPct: 1 });
  assert.equal(best.verdict, 'Held up in this test');
  assert.ok(!/profitable/i.test(`${best.verdict} ${best.detail}`));
});

test('walk-forward folds are chronological, and choose settings from earlier data only', () => {
  const data = candles(1500);
  const r = runWalkForward(data, { strategy: 'ema_cross', interval: '1h', folds: 4 });
  assert.equal(r.folds.length, 4);
  for (let i = 1; i < 4; i++) assert.ok(r.folds[i].startTime > r.folds[i - 1].endTime);
  assert.ok(r.folds.every((f) => paramGrid('ema_cross').some((p) => p.fast === f.chosenParams.fast)));
  // changing candles after fold 2's test window must not change folds 1 and 2
  const cut = data.findIndex((c) => c.openTime > r.folds[1].endTime);
  const changed = data.map((c, i) => (i >= cut ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c));
  const r2 = runWalkForward(changed, { strategy: 'ema_cross', interval: '1h', folds: 4 });
  assert.deepEqual(r2.folds.slice(0, 2), r.folds.slice(0, 2));
});

test('walk-forward works for every strategy, and rejects too little data', () => {
  const data = candles(1500);
  for (const s of ['ema_cross', 'rsi_reversion', 'macd_cross', 'bb_reversion', 'composite']) {
    const r = runWalkForward(data, { strategy: s, interval: '1h', folds: 3 });
    assert.equal(r.folds.length, 3, s);
    assert.ok(Number.isFinite(r.totalReturnPct), s);
  }
  assert.throws(() => runWalkForward(candles(100), { strategy: 'macd_cross', interval: '1h', folds: 4 }), /Not enough candles/);
});

// ---- AI status
test('AI status is honest about each state', async () => {
  const saved = config.anthropicKey;
  try {
    config.anthropicKey = '';
    assert.equal(aiStatus().state, 'not-configured');
    await assert.rejects(aiComplete({ system: 's', user: 'u' }), /AI is off/);
    config.anthropicKey = 'test-key';
    const noCredit = { messages: { create: async () => { throw Object.assign(new Error('400'), { status: 400, error: { error: { message: 'Your credit balance is too low' } } }); } } };
    await assert.rejects(aiComplete({ system: 's', user: 'u', client: noCredit }), /out of credits/);
    assert.equal(aiStatus().state, 'error');
    assert.match(aiStatus().detail, /out of credits/);
    const refusing = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
    await assert.rejects(aiComplete({ system: 's', user: 'u', client: refusing }), /declined/);
    const blank = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }) } };
    await assert.rejects(aiComplete({ system: 's', user: 'u', client: blank }), /no text/, 'an empty reply is an error, not an answer');
    const working = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }) } };
    assert.equal((await aiComplete({ system: 's', user: 'u', client: working })).text, 'hello');
    assert.equal(aiStatus().state, 'ok');
  } finally {
    config.anthropicKey = saved;
  }
});
