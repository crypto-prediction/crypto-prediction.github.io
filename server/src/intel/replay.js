// Market Replay: real Binance candles revealed one at a time. The server holds the candles and only ever sends
// those up to the cursor, and indicators are computed from the same prefix, so future data can't reach the
// browser. Simulated orders stay inside the session and never touch the paper account.
import { computeAll } from '../indicators.js';
import { marketSnapshot } from '../analysis.js';
import { config as appConfig, INTERVALS } from '../config.js';
import { tx } from '../tx.js';
import { buildSeries, strategySignalAt } from './strategy.js';

const WARMUP = 300;
const PAGE = 1000;
const MAX_LOADED = 20;
const CHART_HISTORY = 400;
const MAX_STEP = 500;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const parseKline = (k) => ({
  openTime: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
  volume: Number(k[5]), closeTime: k[6], quoteVolume: Number(k[7]), trades: k[8], takerBuyVolume: Number(k[9]),
});

/** Cash, position and P&L from a list of simulated trades, oldest first. */
export function portfolioFromTrades(trades, startingCash, lastClose) {
  let cash = startingCash, qty = 0, cost = 0, avgPrice = 0, realized = 0, fees = 0, wins = 0, closes = 0;
  for (const t of trades) {
    fees += t.fee;
    if (t.side === 'BUY') {
      const spend = t.qty * t.price + t.fee;
      cash -= spend;
      avgPrice = qty + t.qty > 0 ? (avgPrice * qty + t.price * t.qty) / (qty + t.qty) : 0;
      qty += t.qty;
      cost += spend;
    } else {
      const proceeds = t.qty * t.price - t.fee;
      const basis = qty > 0 ? cost * (t.qty / qty) : 0;
      cash += proceeds;
      realized += proceeds - basis;
      closes++;
      if (proceeds - basis > 0) wins++;
      cost -= basis;
      qty -= t.qty;
      if (qty < 1e-12) { qty = 0; cost = 0; avgPrice = 0; }
    }
  }
  const marketValue = qty * lastClose;
  const equity = cash + marketValue;
  return {
    cash, qty, avgPrice, costBasis: cost, marketValue, equity,
    realizedPnl: realized, unrealizedPnl: qty > 0 ? marketValue - cost : 0, feesPaid: fees,
    returnPct: (equity / startingCash - 1) * 100, closes, winRatePct: closes ? (wins / closes) * 100 : null,
  };
}

export function createReplay({ pool, rest, markets, feeRate = appConfig.paper.feeRate, slippageBps = appConfig.paper.slippageBps }) {
  const loaded = new Map(); // session id -> { candles, warmup, exhausted }. Held on the server only.

  const fetchPage = async (symbol, interval, params) => {
    const raw = await rest.request('/api/v3/klines', { symbol, interval, ...params });
    const now = Date.now();
    return raw.map(parseKline).filter((c) => c.closeTime < now);
  };

  async function candlesFor(session, neededIndex) {
    let entry = loaded.get(session.id);
    if (!entry) {
      const start = new Date(session.start_time).getTime();
      const before = await fetchPage(session.symbol, session.interval, { endTime: start - 1, limit: WARMUP });
      const after = await fetchPage(session.symbol, session.interval, { startTime: start, limit: PAGE });
      entry = { candles: [...before, ...after], warmup: before.length, exhausted: after.length < PAGE };
      loaded.set(session.id, entry);
      if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value);
    }
    while (!entry.exhausted && entry.warmup + neededIndex >= entry.candles.length) {
      const last = entry.candles[entry.candles.length - 1];
      const page = await fetchPage(session.symbol, session.interval, { startTime: last.openTime + 1, limit: PAGE });
      entry.candles.push(...page);
      if (page.length < PAGE) entry.exhausted = true;
    }
    return entry;
  }

  const getSession = async (id, db = pool, lock = false) => {
    const { rows: [s] } = await db.query(`SELECT * FROM replay_sessions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [Number(id)]);
    if (!s) throw bad('No such replay session', 404);
    return s;
  };

  const getTrades = async (id, db = pool) => {
    const { rows } = await db.query('SELECT * FROM replay_trades WHERE session_id=$1 ORDER BY id', [id]);
    return rows;
  };

  async function getStrategy(session) {
    if (!session.strategy_id) return null;
    const { rows: [s] } = await pool.query('SELECT id, name, config FROM strategies WHERE id=$1', [session.strategy_id]);
    return s || null;
  }

  /** Everything the page may see at the cursor. `visible` is cut before anything is computed from it. */
  async function view(session, { candlesFromIndex = null } = {}) {
    const entry = await candlesFor(session, session.cursor_index + 1);
    const end = entry.warmup + session.cursor_index;
    const visible = entry.candles.slice(0, end + 1);
    const current = visible[visible.length - 1];
    const ind = computeAll(visible);
    const trades = await getTrades(session.id);
    const portfolio = portfolioFromTrades(trades, session.starting_cash, current.close);
    const firstReplay = visible[entry.warmup];

    const chartFrom = candlesFromIndex === null ? Math.max(0, end - CHART_HISTORY + 1) : entry.warmup + candlesFromIndex;
    const slice = (a) => a.slice(chartFrom, end + 1);
    const strategy = await getStrategy(session);
    let strategyView = null;
    if (strategy) {
      const series = buildSeries(visible);
      const signal = strategySignalAt(strategy.config, series, end, portfolio.qty > 0);
      // markers are worked out as if holding nothing, from candles the user has already seen
      const markers = [];
      for (let i = Math.max(1, chartFrom); i <= end; i++) {
        const s = strategySignalAt(strategy.config, series, i, false);
        if (s.entry.met) markers.push({ time: visible[i].openTime, kind: 'entry' });
        if (s.exit.met) markers.push({ time: visible[i].openTime, kind: 'exit' });
      }
      strategyView = { id: strategy.id, name: strategy.name, signal, markers };
    }

    return {
      id: session.id,
      symbol: session.symbol,
      interval: session.interval,
      startingCash: session.starting_cash,
      position: session.cursor_index,
      startTime: firstReplay.openTime,
      asOf: current.closeTime,
      price: current.close,
      replacesChart: candlesFromIndex === null,
      candles: slice(visible),
      overlays: { ema20: slice(ind.ema20), ema50: slice(ind.ema50), ema200: slice(ind.ema200) },
      indicators: {
        ...marketSnapshot(visible, ind, end),
        bbUpper: ind.bb.upper[end],
        bbLower: ind.bb.lower[end],
        percentB: ind.bb.percentB[end],
        ema20: ind.ema20[end],
        ema50: ind.ema50[end],
        ema200: ind.ema200[end],
      },
      portfolio,
      buyHoldReturnPct: (current.close / firstReplay.open - 1) * 100,
      trades: trades.slice(-100).reverse(),
      hasMore: end + 1 < entry.candles.length,
      strategy: strategyView,
      source: 'Binance spot historical candles',
    };
  }

  async function create(body = {}) {
    const symbol = String(body.symbol || '').toUpperCase();
    const interval = body.interval;
    const start = Number(body.start);
    const cash = body.cash === undefined ? 10000 : Number(body.cash);
    if (!markets.isActive(symbol)) throw bad(`${symbol || 'That coin'} is not available`);
    if (!INTERVALS.includes(interval)) throw bad('Choose an interval');
    if (!Number.isFinite(start) || start <= 0) throw bad('Choose a start date');
    if (start >= Date.now()) throw bad('The start date must be in the past');
    if (!(cash >= 100 && cash <= 1e9)) throw bad('Starting cash must be between $100 and $1,000,000,000');
    let strategyId = null;
    if (body.strategyId !== undefined && body.strategyId !== null && body.strategyId !== '') {
      const { rows: [s] } = await pool.query('SELECT id FROM strategies WHERE id=$1', [Number(body.strategyId)]);
      if (!s) throw bad('No such strategy');
      strategyId = s.id;
    }
    const first = await fetchPage(symbol, interval, { startTime: start, limit: 1 });
    if (!first.length) throw bad('Binance has no closed candles for this coin and interval after that date');
    const { rows: [session] } = await pool.query(
      `INSERT INTO replay_sessions (symbol, interval, start_time, starting_cash, strategy_id) VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5) RETURNING *`,
      [symbol, interval, first[0].openTime, cash, strategyId]);
    return view(session);
  }

  async function step(id, count) {
    const n = Math.trunc(Number(count) || 0);
    if (!n || Math.abs(n) > MAX_STEP) throw bad(`Step by 1 to ${MAX_STEP} candles`);
    const session = await getSession(id);
    const entry = await candlesFor(session, session.cursor_index + Math.max(n, 0) + 1);
    const last = entry.candles.length - entry.warmup - 1;
    const next = Math.max(0, Math.min(last, session.cursor_index + n));
    if (next === session.cursor_index) return { ...(await view(session, { candlesFromIndex: next + 1 })), moved: 0 };
    const moved = next - session.cursor_index;
    await tx(pool, async (db) => {
      await db.query('UPDATE replay_sessions SET cursor_index=$1, updated_at=now() WHERE id=$2', [next, session.id]);
      // going back undoes anything done after that point, so a later price can't be traded on with hindsight
      if (next < session.cursor_index) await db.query('DELETE FROM replay_trades WHERE session_id=$1 AND candle_index>$2', [session.id, next]);
    });
    const moving = { ...session, cursor_index: next };
    return { ...(await view(moving, moved > 0 ? { candlesFromIndex: session.cursor_index + 1 } : {})), moved };
  }

  async function order(id, body = {}) {
    const side = String(body.side || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') throw bad('side must be BUY or SELL');
    await tx(pool, async (db) => {
      const session = await getSession(id, db, true);
      const entry = await candlesFor(session, session.cursor_index);
      const current = entry.candles[entry.warmup + session.cursor_index];
      const trades = await getTrades(session.id, db);
      const p = portfolioFromTrades(trades, session.starting_cash, current.close);
      const slip = slippageBps / 10000;
      let qty, price, fee;
      if (side === 'BUY') {
        const amount = Number(body.amountUsd);
        if (!(amount >= 1)) throw bad('Enter an amount of at least $1');
        if (amount > p.cash + 1e-9) throw bad(`Not enough simulated cash: you have $${p.cash.toFixed(2)}`);
        price = current.close * (1 + slip);
        fee = amount * feeRate;
        qty = (amount - fee) / price;
      } else {
        if (p.qty <= 0) throw bad('Nothing to sell in this replay');
        price = current.close * (1 - slip);
        qty = body.closeAll ? p.qty : Number(body.amountUsd) / current.close;
        if (!(qty > 0)) throw bad('Enter an amount to sell');
        if (qty > p.qty * (1 + 1e-9)) throw bad(`You hold only ${p.qty.toFixed(6)} in this replay`);
        qty = Math.min(qty, p.qty);
        fee = qty * price * feeRate;
      }
      await db.query(
        `INSERT INTO replay_trades (session_id, candle_index, candle_time, side, qty, price, fee) VALUES ($1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7)`,
        [session.id, session.cursor_index, current.closeTime, side, qty, price, fee]);
    });
    return view(await getSession(id), { candlesFromIndex: Number.MAX_SAFE_INTEGER });
  }

  async function list(limit = 20) {
    const { rows } = await pool.query('SELECT id, symbol, interval, start_time, cursor_index, starting_cash, strategy_id, updated_at FROM replay_sessions ORDER BY updated_at DESC LIMIT $1', [Math.min(100, limit)]);
    return rows;
  }

  async function remove(id) {
    await pool.query('DELETE FROM replay_sessions WHERE id=$1', [Number(id)]);
    loaded.delete(Number(id));
  }

  return { create, get: async (id) => view(await getSession(id)), step, order, list, remove };
}
