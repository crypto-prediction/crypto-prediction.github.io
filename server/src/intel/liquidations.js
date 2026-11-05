// Liquidation intelligence keeps two very different things apart:
// - Reported events: real forced orders from Binance's live stream, saved from when this server started collecting.
// - Estimated zones: a model built from open-interest changes and assumed leverage. They are not known positions.
import { config } from '../config.js';

export const LEVERAGE_ASSUMPTION = [
  { leverage: 5, share: 0.3 }, { leverage: 10, share: 0.3 }, { leverage: 25, share: 0.25 }, { leverage: 50, share: 0.1 }, { leverage: 100, share: 0.05 },
];
const MAINTENANCE_MARGIN = 0.005;
export const ESTIMATE_LABEL = 'Modelled estimate from open-interest changes and assumed leverage. These are not known positions, and real liquidation prices differ.';
export const EVENT_LABEL = 'Reported by Binance as forced orders. Its stream sends at most one per second per coin, so this undercounts busy periods.';

const RANGES = {
  '24h': { period: '15m', limit: 96, kline: '15m' },
  '7d': { period: '1h', limit: 168, kline: '1h' },
  '30d': { period: '4h', limit: 180, kline: '4h' },
};
export const RANGE_NAMES = Object.keys(RANGES);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Walks open interest forward. Each rise is treated as new positions at that price, split between long and short by
 * the account ratio, then spread across assumed leverage. A position drops out once price trades through its
 * estimated liquidation price, and falling open interest shrinks all of them.
 */
export function estimateLiquidationMap({ candles, oiHistory, lsHistory = [], price, rows = 40, columns = 48, spanPct = 25, leverage = LEVERAGE_ASSUMPTION }) {
  const steps = [...oiHistory].sort((a, b) => a.time - b.time);
  if (steps.length < 2 || !candles.length) return null;
  const longShareAt = (t) => {
    let share = 0.5;
    for (const x of lsHistory) { if (x.time <= t) share = x.longShare; else break; }
    return share;
  };
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const closeAt = (t) => {
    let c = null;
    for (const k of sorted) { if (k.closeTime <= t) c = k; else break; }
    return c ?? sorted[0];
  };
  const low = price * (1 - spanPct / 100);
  const high = price * (1 + spanPct / 100);
  const bucket = (high - low) / rows;
  const prices = Array.from({ length: rows }, (_, i) => low + bucket * (i + 0.5));
  const firstColumn = Math.max(1, steps.length - columns);
  const times = [];
  const closes = [];
  const long = prices.map(() => []);
  const short = prices.map(() => []);
  let active = [];
  let cursor = 0;
  let maxCell = 0;

  for (let s = 1; s < steps.length; s++) {
    const t = steps[s].time;
    while (cursor < sorted.length && sorted[cursor].closeTime <= t) {
      const k = sorted[cursor];
      if (k.closeTime > steps[s - 1].time) active = active.filter((c) => (c.side === 'long' ? k.low > c.price : k.high < c.price));
      cursor++;
    }
    const delta = steps[s].usd - steps[s - 1].usd;
    if (delta > 0) {
      const entry = closeAt(t).close;
      const longShare = longShareAt(t);
      for (const tier of leverage) {
        const distance = 1 / tier.leverage - MAINTENANCE_MARGIN;
        active.push({ side: 'long', price: entry * (1 - distance), usd: delta * longShare * tier.share });
        active.push({ side: 'short', price: entry * (1 + distance), usd: delta * (1 - longShare) * tier.share });
      }
    } else if (delta < 0 && steps[s - 1].usd > 0) {
      const keep = Math.max(0, 1 + delta / steps[s - 1].usd);
      active = active.map((c) => ({ ...c, usd: c.usd * keep }));
    }
    if (s >= firstColumn) {
      times.push(t);
      closes.push(closeAt(t).close);
      for (let r = 0; r < rows; r++) { long[r].push(0); short[r].push(0); }
      const col = times.length - 1;
      for (const c of active) {
        const r = Math.floor((c.price - low) / bucket);
        if (r < 0 || r >= rows) continue;
        const grid = c.side === 'long' ? long : short;
        grid[r][col] += c.usd;
        maxCell = Math.max(maxCell, grid[r][col]);
      }
    }
  }

  const last = times.length - 1;
  const zones = (grid, keep) => prices
    .map((p, r) => ({ price: p, usd: grid[r][last] }))
    .filter((z) => z.usd > 0 && keep(z.price))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 5)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  return {
    times, prices, long, short, closes, maxCell,
    price,
    bucketUsd: bucket,
    longZones: zones(long, (p) => p < price),
    shortZones: zones(short, (p) => p > price),
    label: ESTIMATE_LABEL,
    assumptions: { leverage, maintenanceMarginPct: MAINTENANCE_MARGIN * 100, longShareFrom: 'Binance long/short account ratio, an account count rather than position size', covers: `Only positions opened during the ${steps.length} steps shown` },
  };
}

/** Saves real forced orders from Binance's all-market stream, for the coins tracked here. */
export function createLiquidationFeed({ pool, isTracked, baseWs = config.binanceFuturesWs, WS = null, backoffBaseMs = 1000 }) {
  const state = { status: 'stopped', connectedAt: null, lastEventAt: null, saved: 0, seen: 0, lastError: null };
  let ws = null, stopped = true, attempts = 0, timer = null;

  async function save(message) {
    const o = message.o;
    if (!o || message.e !== 'forceOrder') return false;
    state.seen++;
    if (o.X !== 'FILLED' || !isTracked(o.s)) return false;
    const qty = Number(o.z);
    const px = Number(o.ap);
    if (!(qty > 0 && px > 0)) return false;
    const { rowCount } = await pool.query(
      `INSERT INTO liquidation_events (symbol, side, price, qty, usd, event_time) VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
       ON CONFLICT (symbol, side, price, qty, event_time) DO NOTHING`,
      [o.s, o.S === 'SELL' ? 'long' : 'short', px, qty, qty * px, o.T]);
    if (rowCount) { state.saved++; state.lastEventAt = Date.now(); }
    return Boolean(rowCount);
  }

  function connect() {
    if (stopped) return;
    state.status = attempts ? 'reconnecting' : 'connecting';
    ws = new WS(`${baseWs}/ws/!forceOrder@arr`);
    ws.on('open', () => { attempts = 0; state.status = 'connected'; state.connectedAt = Date.now(); });
    ws.on('message', (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      save(m).catch((e) => { state.lastError = e.message; });
    });
    ws.on('error', (e) => { state.lastError = e.message; });
    ws.on('close', () => {
      if (stopped) { state.status = 'stopped'; return; }
      attempts++;
      state.status = 'disconnected';
      timer = setTimeout(connect, Math.min(30000, backoffBaseMs * 2 ** Math.min(attempts - 1, 5)));
    });
  }

  return {
    state,
    save,
    async start() {
      stopped = false;
      if (!WS) WS = (await import('ws')).default;
      connect();
    },
    stop() { stopped = true; clearTimeout(timer); ws?.close(); },
    purge: () => pool.query(`DELETE FROM liquidation_events WHERE event_time < now() - interval '30 days'`),
  };
}

export function createLiquidations({ pool, futuresRest, cached, feed, perpetuals }) {
  async function map(symbol, range = '7d') {
    const spec = RANGES[range];
    if (!spec) throw bad(`Range must be one of ${RANGE_NAMES.join(', ')}`);
    return cached(`liq:map:${symbol}:${range}`, 120000, async () => {
      const perps = await perpetuals();
      if (!perps.has(symbol)) throw bad('Binance lists no USDT perpetual for this coin', 404);
      const [oi, ls, klines, premium] = await Promise.all([
        futuresRest.request('/futures/data/openInterestHist', { symbol, period: spec.period, limit: spec.limit }),
        futuresRest.request('/futures/data/globalLongShortAccountRatio', { symbol, period: spec.period, limit: spec.limit }),
        futuresRest.request('/fapi/v1/klines', { symbol, interval: spec.kline, limit: spec.limit + 1 }),
        futuresRest.request('/fapi/v1/premiumIndex', { symbol }),
      ]);
      const candles = klines.map((k) => ({ openTime: k[0], high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), closeTime: k[6] }));
      const price = Number(premium.markPrice);
      const result = estimateLiquidationMap({
        candles,
        price,
        oiHistory: oi.map((x) => ({ time: x.timestamp, usd: Number(x.sumOpenInterestValue) })),
        lsHistory: ls.map((x) => ({ time: x.timestamp, longShare: Number(x.longAccount) })).sort((a, b) => a.time - b.time),
      });
      if (!result) throw bad('Binance returned too little open-interest history for this range', 503);
      // the coin's real recent volatility, as a band around the price
      const closes = candles.map((c) => c.close);
      const rets = closes.slice(1).map((c, i) => c / closes[i] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
      const perDay = { '15m': 96, '1h': 24, '4h': 6 }[spec.kline];
      const movePct = sd * Math.sqrt(perDay) * 100;
      return {
        symbol, range, source: 'Binance USD-M open interest, long/short ratio and candles', fetchedAt: Date.now(),
        ...result,
        volatilityBand: { dailyMovePct: movePct, low: price * (1 - movePct / 100), high: price * (1 + movePct / 100) },
      };
    });
  }

  async function events(symbol, hours = 24, limit = 100) {
    const h = Math.max(1, Math.min(720, Number(hours) || 24));
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const where = `WHERE symbol=$1 AND event_time >= now() - ($2 || ' hours')::interval`;
    const [recent, hourly, totals, first] = await Promise.all([
      pool.query(`SELECT side, price, qty, usd, event_time FROM liquidation_events ${where} ORDER BY event_time DESC LIMIT $3`, [symbol, String(h), lim]),
      pool.query(`SELECT date_trunc('hour', event_time) AS hour, side, SUM(usd) AS usd, COUNT(*)::int AS count FROM liquidation_events ${where} GROUP BY 1,2 ORDER BY 1`, [symbol, String(h)]),
      pool.query(`SELECT side, SUM(usd) AS usd, COUNT(*)::int AS count FROM liquidation_events ${where} GROUP BY side`, [symbol, String(h)]),
      pool.query('SELECT MIN(event_time) AS first FROM liquidation_events'),
    ]);
    return {
      symbol, hours: h, label: EVENT_LABEL,
      feed: feed ? { status: feed.state.status, connectedAt: feed.state.connectedAt, lastError: feed.state.lastError } : { status: 'off' },
      collectingSince: first.rows[0].first,
      totals: Object.fromEntries(totals.rows.map((r) => [r.side, { usd: r.usd, count: r.count }])),
      hourly: hourly.rows,
      recent: recent.rows,
    };
  }

  return { map, events };
}
