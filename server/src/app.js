import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { config, INTERVALS } from './config.js';
import { coinInfo } from './coins.js';
import { staticMarkets } from './markets.js';
import { computeAll } from './indicators.js';
import { analyze, marketSnapshot, signalAt } from './analysis.js';
import { runBacktest, STRATEGIES } from './backtest.js';
import { createPaper } from './paper.js';
import { aiEnabled, explain } from './ai.js';
import { BinanceError } from './binance/rest.js';
import { attachIntel } from './intel/routes.js';

const SOURCE = 'Binance spot public market data';

export function createApp({ pool, rest, stream, markets = staticMarkets(), fetchImpl, aiClient }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // ---- small TTL cache with in-flight de-duplication, to stay well inside Binance weight limits
  const cache = new Map();
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && (hit.promise || Date.now() - hit.at < ttl)) return hit.promise || hit.value;
    const promise = fn().then((value) => { cache.set(key, { value, at: Date.now() }); return value; })
      .catch((e) => { cache.delete(key); throw e; });
    cache.set(key, { promise });
    return promise;
  }

  // A real price for paper fills: fresh WebSocket price, else a fresh REST quote, else an error.
  async function getPrice(symbol) {
    const live = stream?.livePrice(symbol);
    if (live) return { price: live.price, time: live.eventTime, source: 'binance-ws' };
    try {
      const p = await rest.price(symbol);
      return { price: p.price, time: p.eventTime, source: 'binance-rest' };
    } catch (e) {
      throw Object.assign(new Error(`Live ${symbol} price is unavailable, so the paper order was not placed. ${e.message}`), { status: 503 });
    }
  }
  const lookup = (symbol) => stream?.livePrice(symbol) || null;
  const paper = createPaper(pool, getPrice, { isTradable: markets.isActive });

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    const status = e instanceof BinanceError ? (e.code === 'rate_limited' ? 429 : e.code === 'bad_request' ? 400 : 503) : e.status || 500;
    if (status >= 500 && !(e instanceof BinanceError)) console.error(e);
    res.status(status).json({ error: e.message, code: e.code || 'error', retryAfterMs: e.retryAfterMs || undefined });
  });
  const sym = (s) => {
    const symbol = String(s || markets.active()[0] || '').toUpperCase();
    if (markets.isConfigured(symbol) && !markets.isActive(symbol)) {
      throw Object.assign(new Error(`${symbol} is unavailable: ${markets.reasonFor(symbol) || 'not currently tradable'}`), { status: 410, code: 'symbol_unavailable' });
    }
    return symbol;
  };
  const iv = (i) => (INTERVALS.includes(i) ? i : '1h');
  const historyFor = (symbol, interval, bars = 1000) => cached(`h:${symbol}:${interval}:${bars}`, 30000, () => rest.history(symbol, interval, bars));
  const overviewFor = (interval) => cached(`overview:${interval}`, 30000, () => Promise.all(markets.active().map(async (symbol) => {
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
    const active = markets.active();
    const fromStream = active.map((s) => stream?.tickers[s]).filter((t) => t && stream.livePrice(t.symbol));
    if (fromStream.length === active.length) return { tickers: fromStream, live: true };
    return { tickers: await cached('tickers', 5000, () => rest.tickers24h(active)), live: false };
  };

  app.get('/api/health', wrap(async (_req, res) => {
    let db = 'ok';
    try { await pool.query('SELECT 1'); } catch (e) { db = e.message; }
    res.json({ db, stream: stream?.state ?? null, rest: rest.status(), markets: markets.status(), time: Date.now() });
  }));

  app.get('/api/meta', (_req, res) => res.json({
    symbols: markets.active(),
    coins: config.symbols.map((s) => ({ ...coinInfo(s), available: markets.isActive(s), reason: markets.reasonFor(s) })),
    intervals: INTERVALS, aiEnabled: aiEnabled(), source: SOURCE,
    strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, { label: v.label, description: v.desc, params: v.params }])),
    paper: config.paper,
  }));

  app.get('/api/tickers', wrap(async (_req, res) => {
    const { tickers, live } = await tickersNow();
    res.json({ source: `${SOURCE} (${live ? 'WebSocket' : 'REST'})`, asOf: Date.now(), tickers });
  }));

  app.get('/api/candles', wrap(async (req, res) => {
    const symbol = sym(req.query.symbol), interval = iv(req.query.interval);
    const limit = Math.max(50, Math.min(1000, Number(req.query.limit) || 500));
    // candles only, for the overview visuals that compute nothing from indicators
    if (req.query.indicators === '0') {
      const candles = await cached(`c:${symbol}:${interval}:${limit}`, 10000, () => rest.klines(symbol, interval, limit));
      return res.json({ source: SOURCE, symbol, interval, fetchedAt: Date.now(), candles });
    }
    // fetch 200 extra bars so EMA 200 is defined across the visible range
    const all = await cached(`k:${symbol}:${interval}:${limit}`, 10000, () => rest.klines(symbol, interval, Math.min(1000, limit + 200)));
    const ind = computeAll(all);
    const start = Math.max(0, all.length - limit);
    const slice = (a) => a.slice(start);
    const lastClosed = all.length - 1 - (all[all.length - 1]?.closed === false ? 1 : 0);
    res.json({
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
    });
  }));

  // One row per coin: trend, RSI, MACD and signal, each from that coin's own candles.
  // A coin that fails is reported on its own row and doesn't affect the others.
  app.get('/api/overview', wrap(async (req, res) => {
    const interval = iv(req.query.interval);
    res.json({ source: SOURCE, interval, fetchedAt: Date.now(), coins: await overviewFor(interval) });
  }));

  app.get('/api/analysis', wrap(async (req, res) => {
    const symbol = sym(req.query.symbol), interval = iv(req.query.interval);
    const horizon = Math.max(1, Math.min(100, Number(req.query.horizon) || 12));
    const candles = await cached(`h:${symbol}:${interval}:1000`, 30000, () => rest.history(symbol, interval, 1000));
    const a = analyze(candles, { horizon });
    if (a.error) return res.status(422).json({ error: a.error });
    res.json({ source: SOURCE, symbol, interval, fetchedAt: Date.now(), ...a, aiAvailable: aiEnabled() });
  }));

  app.post('/api/analysis/explain', wrap(async (req, res) => {
    if (!aiEnabled()) return res.status(501).json({ error: 'AI explanations are off. Add ANTHROPIC_API_KEY to server/.env to turn them on.' });
    const symbol = sym(req.body.symbol), interval = iv(req.body.interval);
    const candles = await cached(`h:${symbol}:${interval}:1000`, 30000, () => rest.history(symbol, interval, 1000));
    const a = analyze(candles, { horizon: Number(req.body.horizon) || 12 });
    if (a.error) return res.status(422).json({ error: a.error });
    res.json(await explain(symbol, interval, a));
  }));

  app.post('/api/backtest', wrap(async (req, res) => {
    const b = req.body || {};
    const symbol = sym(b.symbol), interval = iv(b.interval);
    const bars = Math.max(300, Math.min(5000, Number(b.bars) || 1000));
    const candles = await cached(`h:${symbol}:${interval}:${bars}`, 60000, () => rest.history(symbol, interval, bars));
    const result = runBacktest(candles, {
      type: b.strategy || 'ema_cross', params: b.params || {}, interval,
      feeRate: b.feePct === undefined ? 0.001 : Number(b.feePct) / 100,
      slippageBps: b.slippageBps === undefined ? 5 : Number(b.slippageBps),
      outOfSamplePct: b.outOfSamplePct === undefined ? 30 : Number(b.outOfSamplePct),
    });
    const { rows: [row] } = await pool.query(
      `INSERT INTO backtest_runs (symbol, interval, strategy, params, assumptions, metrics, in_sample, out_sample, data_source, data_from, data_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0),to_timestamp($11/1000.0)) RETURNING id, created_at`,
      [symbol, interval, result.strategy.type, result.strategy.params, result.assumptions, result.metrics, result.inSample, result.outOfSample,
        SOURCE, result.metrics.startTime, result.metrics.endTime]);
    res.json({ id: row.id, createdAt: row.created_at, source: SOURCE, symbol, interval, candlesUsed: candles.filter((c) => c.closed).length, ...result });
  }));

  app.get('/api/backtests', wrap(async (_req, res) => {
    const { rows } = await pool.query('SELECT id, symbol, interval, strategy, params, metrics, out_sample, data_from, data_to, created_at FROM backtest_runs ORDER BY id DESC LIMIT 20');
    res.json(rows);
  }));

  app.get('/api/paper/portfolio', wrap(async (_req, res) => res.json(await paper.portfolio(lookup))));
  app.get('/api/paper/trades', wrap(async (req, res) => res.json(await paper.trades(Number(req.query.limit) || 100))));
  app.get('/api/paper/equity', wrap(async (_req, res) => res.json(await paper.equityHistory())));
  app.post('/api/paper/order', wrap(async (req, res) => {
    const t = await paper.order({ ...req.body, symbol: sym(req.body.symbol) });
    res.json({ trade: t, portfolio: await paper.portfolio(lookup) });
  }));
  app.post('/api/paper/reset', wrap(async (_req, res) => { await paper.reset(); res.json(await paper.portfolio(lookup)); }));

  const intel = attachIntel(app, { pool, rest, stream, markets, paper, lookup, cached, wrap, sym, iv, historyFor, overviewFor, tickersNow, fetchImpl, aiClient });

  return { app, paper, lookup, intel };
}

/** Relays Binance stream events to browser clients. Clients subscribe to one symbol+interval for klines. */
export function attachWs(server, stream, intel) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const send = (c, m) => { if (c.readyState === 1) c.send(JSON.stringify(m)); };
  wss.on('connection', (c) => {
    c.sub = { symbol: config.symbols[0], interval: '1h' };
    send(c, { type: 'status', ...stream.state });
    for (const t of Object.values(stream.tickers)) send(c, { type: 'ticker', data: t });
    c.on('message', (buf) => {
      try {
        const m = JSON.parse(buf.toString());
        if (m.type === 'subscribe' && config.symbols.includes(m.symbol) && INTERVALS.includes(m.interval)) c.sub = { symbol: m.symbol, interval: m.interval };
        if (m.type === 'alerts') c.wantsAlerts = true; // only the lab page asks; the dashboard's feed is unchanged
      } catch { /* ignore */ }
    });
  });
  const lastTicker = {};
  stream.on('ticker', (t) => {
    if (Date.now() - (lastTicker[t.symbol] || 0) < 1000) return;
    lastTicker[t.symbol] = Date.now();
    for (const c of wss.clients) send(c, { type: 'ticker', data: t });
  });
  stream.on('kline', (k) => {
    for (const c of wss.clients) if (c.sub.symbol === k.symbol && c.sub.interval === k.interval) send(c, { type: 'kline', data: k });
  });
  stream.on('status', (s) => { for (const c of wss.clients) send(c, { type: 'status', ...s }); });
  intel?.alerts?.events.on('alert', (a) => { for (const c of wss.clients) if (c.wantsAlerts) send(c, { type: 'alert', data: a }); });
  return wss;
}
