// Order Book Intelligence: real Binance spot depth, as REST snapshots plus a live WebSocket feed.
// Visible orders can be cancelled at any moment, so nothing here treats them as proof of intent.
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { median } from './http.js';

const BANDS = [0.1, 0.5, 1];
const WALL_MULTIPLE = 5;
const MAX_WALLS = 5;
export const SOURCE = 'Binance spot order book';
export const CAUTION = 'Visible orders can be cancelled or moved at any moment, and some are placed with no intent to trade. Large orders are not confirmed whale activity.';

const levels = (rows) => rows.map(([p, q]) => [Number(p), Number(q)]);
const sumUsd = (rows) => rows.reduce((s, [p, q]) => s + p * q, 0);

function sampleCurve(rows, points = 40) {
  let total = 0;
  const all = rows.map(([p, q]) => { total += p * q; return { price: p, usd: total }; });
  if (all.length <= points) return all;
  const step = (all.length - 1) / (points - 1);
  return Array.from({ length: points }, (_, i) => all[Math.round(i * step)]);
}

function findWalls(rows) {
  const typical = median(rows.map(([p, q]) => p * q));
  if (!typical) return [];
  return rows
    .map(([price, qty]) => ({ price, qty, usd: price * qty, timesTypical: (price * qty) / typical }))
    .filter((w) => w.timesTypical >= WALL_MULTIPLE)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_WALLS);
}

function readPressure(imbalance) {
  const size = Math.abs(imbalance);
  if (size < 0.2) return { label: 'Balanced', detail: 'Visible bids and asks are roughly even.' };
  const side = imbalance > 0 ? 'bids' : 'asks';
  const other = imbalance > 0 ? 'asks' : 'bids';
  const buying = imbalance > 0 ? 'buying' : 'selling';
  return size >= 0.5
    ? { label: `Strong ${buying} pressure`, detail: `Visible ${side} far outweigh ${other} near the price.` }
    : { label: `Moderate ${buying} pressure`, detail: `Visible ${side} outweigh ${other} near the price.` };
}

const sameWall = (a, b) => Math.abs(a.price - b.price) / a.price < 0.0001;

/** Liquidity and pressure from one snapshot. `previous` is the last analysis, for spotting what changed. */
export function analyzeDepth(raw, { previous = null, spreadHistory = [] } = {}) {
  const bids = levels(raw.bids);
  const asks = levels(raw.asks);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 1e4;
  const coveredBidPct = ((mid - bids[bids.length - 1][0]) / mid) * 100;
  const coveredAskPct = ((asks[asks.length - 1][0] - mid) / mid) * 100;
  const bands = BANDS.map((pct) => {
    const bidUsd = sumUsd(bids.filter(([p]) => p >= mid * (1 - pct / 100)));
    const askUsd = sumUsd(asks.filter(([p]) => p <= mid * (1 + pct / 100)));
    return { pct, bidUsd, askUsd, imbalance: bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0, complete: coveredBidPct >= pct && coveredAskPct >= pct };
  });
  const near = bands.find((b) => b.pct === 0.5);
  const walls = { bids: findWalls(bids), asks: findWalls(asks) };

  const changes = [];
  if (previous) {
    const was = previous.bands.find((b) => b.pct === 0.5);
    const pct = (now, then) => (then > 0 ? (now / then - 1) * 100 : 0);
    const bidChange = pct(near.bidUsd, was.bidUsd);
    const askChange = pct(near.askUsd, was.askUsd);
    if (Math.abs(bidChange) >= 25) changes.push({ kind: 'liquidity', text: `Bids within 0.5% ${bidChange > 0 ? 'rose' : 'fell'} ${Math.abs(bidChange).toFixed(0)}% since the last snapshot.` });
    if (Math.abs(askChange) >= 25) changes.push({ kind: 'liquidity', text: `Asks within 0.5% ${askChange > 0 ? 'rose' : 'fell'} ${Math.abs(askChange).toFixed(0)}% since the last snapshot.` });
    for (const [label, now, then] of [['bid', walls.bids, previous.walls.bids], ['ask', walls.asks, previous.walls.asks]]) {
      for (const w of now) if (!then.some((x) => sameWall(x, w))) changes.push({ kind: 'wall-new', text: `A large ${label} appeared at ${w.price}.` });
      for (const w of then) if (!now.some((x) => sameWall(x, w))) changes.push({ kind: 'wall-gone', text: `The large ${label} at ${w.price} is gone: filled or cancelled, the book can't say which.` });
    }
  }
  const typicalSpread = median(spreadHistory);
  if (typicalSpread && spreadBps >= typicalSpread * 2 && spreadBps > 0.5) changes.push({ kind: 'spread', text: `The spread widened to ${spreadBps.toFixed(2)} bps, from a typical ${typicalSpread.toFixed(2)} bps.` });

  return {
    mid, bestBid, bestAsk, spreadBps, bands, walls, changes,
    coveredBidPct, coveredAskPct,
    pressure: { imbalance: near.imbalance, ...readPressure(near.imbalance) },
    curve: { bids: sampleCurve(bids), asks: sampleCurve(asks) },
    caution: CAUTION,
  };
}

/** One upstream socket per coin being watched, closed again when nobody is watching. */
export function createBookFeed({ baseWs = config.binanceWs, WS = null, backoffBaseMs = 1000, relayEveryMs = 1000 } = {}) {
  const feeds = new Map();

  function open(symbol) {
    const feed = feeds.get(symbol);
    if (!feed) return;
    const url = `${baseWs}/ws/${symbol.toLowerCase()}@depth20@100ms`;
    const ws = new WS(url);
    feed.ws = ws;
    ws.on('open', () => { feed.attempts = 0; });
    ws.on('message', (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m.bids || !m.asks) return;
      feed.latest = { symbol, bids: m.bids, asks: m.asks, time: Date.now(), source: SOURCE };
      const now = Date.now();
      if (now - feed.relayedAt >= relayEveryMs) {
        feed.relayedAt = now;
        feed.events.emit('book', feed.latest);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (feeds.get(symbol) !== feed || feed.listeners === 0) return;
      feed.attempts++;
      feed.timer = setTimeout(() => open(symbol), Math.min(30000, backoffBaseMs * 2 ** Math.min(feed.attempts - 1, 5)));
    });
  }

  async function subscribe(symbol, onBook) {
    if (!WS) WS = (await import('ws')).default;
    let feed = feeds.get(symbol);
    if (!feed) {
      feed = { events: new EventEmitter(), listeners: 0, attempts: 0, relayedAt: 0, latest: null, ws: null, timer: null };
      feeds.set(symbol, feed);
      open(symbol);
    }
    feed.listeners++;
    feed.events.on('book', onBook);
    if (feed.latest) onBook(feed.latest);
    return () => {
      feed.events.off('book', onBook);
      feed.listeners--;
      if (feed.listeners === 0) {
        clearTimeout(feed.timer);
        feeds.delete(symbol);
        feed.ws?.close();
      }
    };
  }

  return { subscribe, active: () => [...feeds.keys()] };
}

export function createOrderBook({ pool, rest, cached }) {
  const memory = new Map(); // symbol -> { analysis, spreads, sampledAt }

  async function saveSample(symbol, a) {
    const near = a.bands.find((b) => b.pct === 0.5);
    await pool.query(
      'INSERT INTO book_samples (symbol, mid, spread_bps, bid_usd, ask_usd, imbalance) VALUES ($1,$2,$3,$4,$5,$6)',
      [symbol, a.mid, a.spreadBps, near.bidUsd, near.askUsd, near.imbalance]);
  }

  async function snapshot(symbol) {
    return cached(`depth:${symbol}`, 5000, async () => {
      const raw = await rest.request('/api/v3/depth', { symbol, limit: 500 });
      const state = memory.get(symbol) || { analysis: null, spreads: [], sampledAt: 0 };
      const analysis = analyzeDepth(raw, { previous: state.analysis, spreadHistory: state.spreads });
      if (!analysis) throw Object.assign(new Error('The order book came back empty'), { status: 503 });
      state.analysis = analysis;
      state.spreads = [...state.spreads, analysis.spreadBps].slice(-120);
      const now = Date.now();
      if (now - state.sampledAt >= 60000) {
        state.sampledAt = now;
        await saveSample(symbol, analysis).catch(() => {});
      }
      memory.set(symbol, state);
      return { symbol, source: SOURCE, time: now, lastUpdateId: raw.lastUpdateId, ...analysis };
    });
  }

  async function history(symbol, hours = 24) {
    const h = Math.max(1, Math.min(14 * 24, Number(hours) || 24));
    const { rows } = await pool.query(
      `SELECT ts, spread_bps, bid_usd, ask_usd, imbalance FROM book_samples WHERE symbol=$1 AND ts >= now() - ($2 || ' hours')::interval ORDER BY ts LIMIT 2000`,
      [symbol, String(h)]);
    return { symbol, hours: h, samples: rows, source: SOURCE };
  }

  /** A sample of every coin, so imbalance history builds up without the page open. */
  async function sampleAll(symbols) {
    for (const symbol of symbols) {
      const raw = await rest.request('/api/v3/depth', { symbol, limit: 100 });
      const a = analyzeDepth(raw);
      if (a) await saveSample(symbol, a);
    }
    await pool.query(`DELETE FROM book_samples WHERE ts < now() - interval '14 days'`);
  }

  return { snapshot, history, sampleAll };
}
