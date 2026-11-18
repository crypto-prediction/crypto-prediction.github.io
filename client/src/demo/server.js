// The online demo's stand-in for the Signal Lab server. It answers the same /api requests with the same
// shapes, using the server's own indicator, signal, backtest, forecast, futures and risk code, run in the browser.
// Features that need the real server (a database, scheduled jobs, AI or other data sources) answer with a clear 501.
import { COINS, coinInfo } from '../../../server/src/coins.js';
import { computeAll } from '../../../server/src/indicators.js';
import { analyze, marketSnapshot, signalAt } from '../../../server/src/analysis.js';
import { runBacktest, STRATEGIES } from '../../../server/src/backtest.js';
import { forecast, HORIZONS, MODEL_ID, supportResistance } from '../../../server/src/intel/forecast.js';
import { createLab, MAX_COMBINATIONS, MIN_TRADES } from '../../../server/src/intel/lab.js';
import { createFutures } from '../../../server/src/intel/futures.js';
import { normalizeScenario, simulateRisk } from '../../../server/src/intel/risk.js';
import { BinanceError, createRest, createStream, SOURCE } from './binance.js';
import { createPaper, PaperError } from './paper.js';

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const SYMBOLS = COINS.map((c) => c.symbol);
const BACKTESTS_KEY = 'signal-lab-demo-backtests-v1';
export const NOT_IN_DEMO = 'Not in the online demo. This needs the Signal Lab server: run the full app on your computer (see the README on GitHub).';
const AI_STATUS = { configured: false, state: 'not-configured', detail: 'AI is off in the online demo.', model: null, at: null };

const fail = (status, message, code = 'error') => Object.assign(new Error(message), { status, code });

export function createDemoServer() {
  const rest = createRest();
  const futuresRest = createRest({ futures: true });
  const stream = createStream(SYMBOLS);
  const markets = { active: () => SYMBOLS, isActive: (s) => SYMBOLS.includes(s), isConfigured: (s) => SYMBOLS.includes(s) };

  const cache = new Map();
  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && (hit.promise || Date.now() - hit.at < ttl)) return hit.promise || Promise.resolve(hit.value);
    const promise = fn().then((value) => { cache.set(key, { value, at: Date.now() }); return value; })
      .catch((e) => { cache.delete(key); throw e; });
    cache.set(key, { promise });
    return promise;
  }

  async function getPrice(symbol) {
    const live = stream.livePrice(symbol);
    if (live) return { price: live.price, time: live.eventTime, source: 'binance-ws' };
    try {
      const p = await rest.price(symbol);
      return { price: p.price, time: p.eventTime, source: 'binance-rest' };
    } catch (e) {
      throw fail(503, `Live ${symbol} price is unavailable, so the paper order was not placed. ${e.message}`);
    }
  }
  const lookup = (symbol) => stream.livePrice(symbol);
  const paper = createPaper({ getPrice, isTradable: markets.isActive });
  setInterval(() => paper.snapshot(lookup), 60000);

  const sym = (s) => {
    const symbol = String(s || SYMBOLS[0]).toUpperCase();
    if (!SYMBOLS.includes(symbol)) throw fail(400, `Unsupported symbol ${symbol}`, 'bad_request');
    return symbol;
  };
  const iv = (i) => (INTERVALS.includes(i) ? i : '1h');
  const historyFor = (symbol, interval, bars = 1000) => cached(`h:${symbol}:${interval}:${bars}`, 30000, () => rest.history(symbol, interval, bars));
  const overviewFor = (interval) => cached(`overview:${interval}`, 30000, () => Promise.all(SYMBOLS.map(async (symbol) => {
    try {
      const candles = (await historyFor(symbol, interval)).filter((c) => c.closed !== false);
      if (candles.length < 2) return { symbol, error: 'Not enough candles yet' };
      const ind = computeAll(candles);
      const i = candles.length - 1;
      const s = signalAt(ind, candles, i);
      return { symbol, ...marketSnapshot(candles, ind, i), signal: s?.signal ?? null, score: s?.score ?? null };
    } catch (e) {
      return { symbol, error: e.message };
    }
  })));
  const tickersNow = async () => {
    const fromStream = SYMBOLS.map((s) => stream.tickers[s]).filter((t) => t && stream.livePrice(t.symbol));
    if (fromStream.length === SYMBOLS.length) return { tickers: fromStream, live: true };
    return { tickers: await cached('tickers', 5000, () => rest.tickers24h(SYMBOLS)), live: false };
  };
  const forecastFor = (symbol, horizon) => {
    const spec = HORIZONS[horizon];
    if (!spec) return Promise.reject(fail(400, `Unknown horizon ${horizon}`));
    return cached(`fc:${symbol}:${horizon}`, spec.history > 1000 ? 5 * 60e3 : 60e3, async () => (
      { symbol, ...forecast(await historyFor(symbol, spec.interval, spec.history), horizon, { livePrice: stream.livePrice(symbol)?.price ?? null }) }
    ));
  };
  const lab = createLab({ historyFor, isActive: markets.isActive, intervals: INTERVALS });
  const futures = createFutures({ futuresRest, cached, markets, tickersNow, overviewFor });

  const loadBacktests = () => { try { return JSON.parse(localStorage.getItem(BACKTESTS_KEY) || '[]'); } catch { return []; } };
  const saveBacktests = (rows) => { try { localStorage.setItem(BACKTESTS_KEY, JSON.stringify(rows.slice(0, 20))); } catch { /* private mode */ } };

  const routes = [
    ['GET', '/health', () => ({ db: 'not used in the online demo', stream: { ...stream.state }, rest: rest.status(), markets: { configured: SYMBOLS.length, active: SYMBOLS.length }, time: Date.now(), demo: true })],
    ['GET', '/meta', () => ({
      symbols: SYMBOLS,
      coins: SYMBOLS.map((s) => ({ ...coinInfo(s), available: true, reason: null })),
      intervals: INTERVALS, aiEnabled: false, source: SOURCE,
      strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, { label: v.label, description: v.desc, params: v.params }])),
      paper: { startingBalance: 10000, feeRate: 0.001, slippageBps: 5 },
      demo: true,
    })],
    ['GET', '/tickers', async () => {
      const { tickers, live } = await tickersNow();
      return { source: `${SOURCE} (${live ? 'WebSocket' : 'REST'})`, asOf: Date.now(), tickers };
    }],
    ['GET', '/candles', async (q) => {
      const symbol = sym(q.get('symbol')), interval = iv(q.get('interval'));
      const limit = Math.max(50, Math.min(1000, Number(q.get('limit')) || 500));
      if (q.get('indicators') === '0') {
        const candles = await cached(`c:${symbol}:${interval}:${limit}`, 10000, () => rest.klines(symbol, interval, limit));
        return { source: SOURCE, symbol, interval, fetchedAt: Date.now(), candles };
      }
      const all = await cached(`k:${symbol}:${interval}:${limit}`, 10000, () => rest.klines(symbol, interval, Math.min(1000, limit + 200)));
      const ind = computeAll(all);
      const start = Math.max(0, all.length - limit);
      const slice = (a) => a.slice(start);
      const lastClosed = all.length - 1 - (all[all.length - 1]?.closed === false ? 1 : 0);
      return {
        source: SOURCE, symbol, interval, fetchedAt: Date.now(),
        candles: slice(all),
        snapshot: lastClosed >= 1 ? marketSnapshot(all, ind, lastClosed) : null,
        indicators: {
          ema20: slice(ind.ema20), ema50: slice(ind.ema50), ema200: slice(ind.ema200), rsi14: slice(ind.rsi14),
          macd: { macd: slice(ind.macd.macd), signal: slice(ind.macd.signal), histogram: slice(ind.macd.histogram) },
          bb: { upper: slice(ind.bb.upper), middle: slice(ind.bb.middle), lower: slice(ind.bb.lower), percentB: slice(ind.bb.percentB) },
          volume: { average: slice(ind.volume.average), relative: slice(ind.volume.relative), obv: slice(ind.volume.obv), buyShare: slice(ind.volume.buyShare) },
          momentum: slice(ind.momentum), volatility: slice(ind.volatility),
        },
      };
    }],
    ['GET', '/overview', async (q) => {
      const interval = iv(q.get('interval'));
      return { source: SOURCE, interval, fetchedAt: Date.now(), coins: await overviewFor(interval) };
    }],
    ['GET', '/analysis', async (q) => {
      const symbol = sym(q.get('symbol')), interval = iv(q.get('interval'));
      const horizon = Math.max(1, Math.min(100, Number(q.get('horizon')) || 12));
      const a = analyze(await historyFor(symbol, interval, 1000), { horizon });
      if (a.error) throw fail(422, a.error);
      return { source: SOURCE, symbol, interval, fetchedAt: Date.now(), ...a, aiAvailable: false };
    }],
    ['POST', '/analysis/explain', () => { throw fail(501, 'AI explanations are off in the online demo.'); }],
    ['POST', '/backtest', async (_q, b) => {
      const symbol = sym(b.symbol), interval = iv(b.interval);
      const bars = Math.max(300, Math.min(5000, Number(b.bars) || 1000));
      const candles = await cached(`h:${symbol}:${interval}:${bars}`, 60000, () => rest.history(symbol, interval, bars));
      const result = runBacktest(candles, {
        type: b.strategy || 'ema_cross', params: b.params || {}, interval,
        feeRate: b.feePct === undefined ? 0.001 : Number(b.feePct) / 100,
        slippageBps: b.slippageBps === undefined ? 5 : Number(b.slippageBps),
        outOfSamplePct: b.outOfSamplePct === undefined ? 30 : Number(b.outOfSamplePct),
      });
      const rows = loadBacktests();
      const id = (rows[0]?.id ?? 0) + 1;
      const createdAt = new Date().toISOString();
      rows.unshift({ id, symbol, interval, strategy: result.strategy.type, params: result.strategy.params, metrics: result.metrics, out_sample: result.outOfSample,
        data_from: new Date(result.metrics.startTime).toISOString(), data_to: new Date(result.metrics.endTime).toISOString(), created_at: createdAt });
      saveBacktests(rows);
      return { id, createdAt, source: SOURCE, symbol, interval, candlesUsed: candles.filter((c) => c.closed).length, ...result };
    }],
    ['GET', '/backtests', () => loadBacktests()],
    ['GET', '/paper/portfolio', () => paper.portfolio(lookup)],
    ['GET', '/paper/trades', (q) => paper.trades(Number(q.get('limit')) || 100)],
    ['GET', '/paper/equity', () => paper.equityHistory()],
    ['POST', '/paper/order', async (_q, b) => {
      const trade = await paper.order({ ...b, symbol: sym(b.symbol) });
      paper.snapshot(lookup);
      return { trade, portfolio: paper.portfolio(lookup) };
    }],
    ['POST', '/paper/reset', () => { paper.reset(); return paper.portfolio(lookup); }],

    // ---- Intelligence Lab tabs that can run in the browser
    ['GET', '/intel/status', () => ({
      forecasting: { model: MODEL_ID, type: 'statistical', running: true, detail: 'Logistic regression on technical indicators, running in your browser. It needs no AI service.' },
      ai: AI_STATUS,
      tracker: { saved: 0, pending: 0, scored: 0 },
      horizons: Object.keys(HORIZONS),
      alertTypes: {}, customMetrics: {},
      lab: { minimumTrades: MIN_TRADES, maxCombinations: MAX_COMBINATIONS },
    })],
    ['GET', '/forecast', async (q) => {
      const horizon = String(q.get('horizon') || '24h');
      if (!HORIZONS[horizon]) throw fail(400, `Horizon must be one of ${Object.keys(HORIZONS).join(', ')}`);
      const symbols = q.get('symbol') ? [sym(q.get('symbol'))] : SYMBOLS;
      const forecasts = await Promise.all(symbols.map(async (s) => {
        try { return await forecastFor(s, horizon); } catch (e) { return { symbol: s, unavailable: e.message }; }
      }));
      return { horizon, fetchedAt: Date.now(), forecasts, disclaimer: 'A statistical estimate from past candles. It is not a guarantee and not financial advice.' };
    }],
    ['POST', '/lab/compare', (_q, b) => lab.compare(b)],
    ['POST', '/lab/walkforward', (_q, b) => lab.walkForward({ ...b, interval: iv(b?.interval) })],
    ['GET', '/futures/overview', () => futures.overview()],
    ['GET', '/futures/detail', async (q) => ({ ...(await futures.detail(sym(q.get('symbol')))), nearestEstimatedLiquidations: null })],
    ['POST', '/risk/simulate', async (_q, b) => {
      const scenario = normalizeScenario(b, markets.isActive);
      const pf = paper.portfolio(lookup);
      const unpriced = pf.positions.filter((p) => p.marketValue === null).map((p) => p.symbol);
      const positions = scenario.useCurrent ? pf.positions.filter((p) => p.marketValue !== null).map((p) => ({ symbol: p.symbol, value: p.marketValue })) : [];
      for (const h of scenario.hypothetical) {
        const existing = positions.find((p) => p.symbol === h.symbol);
        if (existing) existing.value += h.value;
        else positions.push({ symbol: h.symbol, value: h.value });
      }
      const cash = scenario.useCurrent ? pf.cash : 0;
      const needed = new Set([...positions.map((p) => p.symbol), SYMBOLS[0]]);
      const returnsBySymbol = {};
      const levels = {};
      await Promise.all([...needed].map(async (s) => {
        const candles = (await historyFor(s, '1h')).filter((c) => c.closed !== false);
        const closes = candles.map((c) => c.close);
        returnsBySymbol[s] = closes.slice(1).map((c, i) => c / closes[i] - 1);
        const price = closes[closes.length - 1];
        levels[s] = { price, ...supportResistance(candles, price) };
      }));
      return { ...simulateRisk({ positions, cash, returnsBySymbol, btcSymbol: SYMBOLS[0], levels }, scenario), unpriced, account: { cash: pf.cash, positions: pf.positions.length, equity: pf.equity } };
    }],
  ];

  async function handle(method, path, query, body) {
    const route = routes.find(([m, p]) => m === method && p === path);
    if (!route) return { status: 501, body: { error: NOT_IN_DEMO, code: 'not_in_demo' } };
    try {
      return { status: 200, body: await route[2](query, body || {}) };
    } catch (e) {
      const status = e instanceof BinanceError ? e.status : e instanceof PaperError ? e.status : e.status || 500;
      if (status >= 500 && !(e instanceof BinanceError)) console.error(e);
      return { status, body: { error: e.message, code: e.code || 'error' } };
    }
  }

  return { handle, stream };
}
