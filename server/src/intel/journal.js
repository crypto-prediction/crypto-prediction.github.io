// Trading Journal. It reads paper trades and never changes them: notes and reasons live in their own table,
// keyed by trade id. Market context is worked out from real candles around each trade.
import { computeAll } from '../indicators.js';
import { marketSnapshot } from '../analysis.js';

const DUST = 1e-9;
const MIN_FOR_PATTERN = 3;
const MIN_FOR_JUDGEMENT = 5;
const OVERTRADING_PER_DAY = 10;

/** Groups trades (oldest first) into round trips, from the first buy until the position is flat again. */
export function buildRoundTrips(trades) {
  const open = new Map();
  const trips = [];
  for (const t of trades) {
    const at = new Date(t.created_at).getTime();
    let trip = open.get(t.symbol);
    if (t.side === 'BUY') {
      if (!trip) {
        trip = { id: t.id, symbol: t.symbol, openedAt: at, closedAt: null, status: 'open', tradeIds: [], qtyOpen: 0, boughtQty: 0, boughtCost: 0, soldQty: 0, soldValue: 0, sizeUsd: 0, fees: 0, pnl: 0, exitCostBasis: 0 };
        open.set(t.symbol, trip);
        trips.push(trip);
      }
      trip.boughtQty += t.qty;
      trip.boughtCost += t.qty * t.fill_price;
      trip.qtyOpen += t.qty;
      trip.sizeUsd += t.notional + t.fee;
    } else if (trip) {
      trip.soldQty += t.qty;
      trip.soldValue += t.qty * t.fill_price;
      trip.qtyOpen -= t.qty;
      trip.pnl += t.realized_pnl ?? 0;
    } else {
      continue; // a sale whose buy was cleared by an account reset can't be paired
    }
    trip.fees += t.fee;
    trip.tradeIds.push(t.id);
    if (trip.qtyOpen * t.fill_price < 0.01 || trip.qtyOpen < DUST) {
      if (t.side === 'SELL') {
        trip.status = 'closed';
        trip.closedAt = at;
        open.delete(t.symbol);
      }
    }
  }
  return trips.map((trip) => ({
    id: trip.id,
    symbol: trip.symbol,
    status: trip.status,
    openedAt: trip.openedAt,
    closedAt: trip.closedAt,
    holdingMs: trip.closedAt ? trip.closedAt - trip.openedAt : null,
    tradeIds: trip.tradeIds,
    entryPrice: trip.boughtQty ? trip.boughtCost / trip.boughtQty : null,
    exitPrice: trip.soldQty ? trip.soldValue / trip.soldQty : null,
    qty: trip.boughtQty,
    sizeUsd: trip.sizeUsd,
    fees: trip.fees,
    pnl: trip.status === 'closed' ? trip.pnl : null,
    realizedSoFar: trip.pnl,
    returnPct: trip.status === 'closed' && trip.sizeUsd ? (trip.pnl / trip.sizeUsd) * 100 : null,
  }));
}

const group = (trips, keyOf) => {
  const out = {};
  for (const t of trips) (out[keyOf(t)] ||= []).push(t);
  return Object.entries(out).map(([key, list]) => {
    const wins = list.filter((t) => t.pnl > 0);
    return { key, trips: list.length, wins: wins.length, winRatePct: (wins.length / list.length) * 100, pnl: list.reduce((s, t) => s + t.pnl, 0) };
  }).sort((a, b) => b.pnl - a.pnl);
};

const hours = (ms) => ms / 3600e3;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Statistics and findings from closed round trips. Every finding quotes its sample size. */
export function analyzeTrips(trips) {
  const closed = trips.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const avgWin = avg(wins.map((t) => t.pnl));
  const avgLoss = avg(losses.map((t) => t.pnl));
  const perDay = {};
  for (const t of trips) {
    const day = new Date(t.openedAt).toISOString().slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  }
  const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0] || null;
  const byStrategy = group(closed, (t) => t.strategyName || 'No strategy recorded');
  const byCoin = group(closed, (t) => t.symbol);
  const byMarket = group(closed.filter((t) => t.context?.trend), (t) => t.context.trend);

  const findings = [];
  if (closed.length < MIN_FOR_JUDGEMENT) {
    findings.push(closed.length
      ? `Only ${closed.length} closed ${closed.length === 1 ? 'trade' : 'trades'} so far. At least ${MIN_FOR_JUDGEMENT} are needed before patterns mean much.`
      : `No closed trades yet. At least ${MIN_FOR_JUDGEMENT} are needed before patterns mean much.`);
  } else {
    for (const g of byMarket) {
      if (g.trips >= MIN_FOR_PATTERN && g.winRatePct < 40) findings.push(`You won ${g.wins} of ${g.trips} trades entered in a market reading "${g.key}".`);
    }
    for (const g of byCoin) {
      if (g.trips >= MIN_FOR_PATTERN && g.pnl < 0 && g.winRatePct < 40) findings.push(`${g.key} is a weak spot: ${g.wins} wins from ${g.trips} trades.`);
    }
    if (avgWin !== null && avgLoss !== null && Math.abs(avgLoss) > avgWin) findings.push(`Your average loss ($${Math.abs(avgLoss).toFixed(2)}) is bigger than your average win ($${avgWin.toFixed(2)}).`);
    const lossHold = avg(losses.filter((t) => t.holdingMs).map((t) => t.holdingMs));
    const winHold = avg(wins.filter((t) => t.holdingMs).map((t) => t.holdingMs));
    if (lossHold && winHold && lossHold > winHold * 1.5 && losses.length >= MIN_FOR_PATTERN) findings.push(`You held losing trades for ${hours(lossHold).toFixed(1)}h on average, against ${hours(winHold).toFixed(1)}h for winners.`);
  }
  if (busiest && busiest[1] > OVERTRADING_PER_DAY) findings.push(`Possible overtrading: ${busiest[1]} trades opened on ${busiest[0]}.`);
  const withTiming = closed.filter((t) => t.timing);
  const entryEff = avg(withTiming.map((t) => t.timing.entryEfficiency).filter((x) => x !== null));
  const exitEff = avg(withTiming.map((t) => t.timing.exitEfficiency).filter((x) => x !== null));
  if (withTiming.length >= MIN_FOR_PATTERN && entryEff !== null && entryEff < 0.4) findings.push(`Entries tended to come late: on average ${(entryEff * 100).toFixed(0)}% of each trade's price range was still above your entry.`);
  if (withTiming.length >= MIN_FOR_PATTERN && exitEff !== null && exitEff < 0.4) findings.push(`Exits tended to come early or late: on average your exit was ${(exitEff * 100).toFixed(0)}% of the way up each trade's price range.`);

  return {
    closedTrips: closed.length,
    openTrips: trips.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
    totalPnl: closed.reduce((s, t) => s + t.pnl, 0),
    totalFees: trips.reduce((s, t) => s + t.fees, 0),
    avgWin,
    avgLoss,
    rewardRisk: avgWin !== null && avgLoss ? avgWin / Math.abs(avgLoss) : null,
    avgHoldingHours: closed.length ? hours(avg(closed.map((t) => t.holdingMs))) : null,
    busiestDay: busiest ? { day: busiest[0], trips: busiest[1] } : null,
    entryEfficiency: entryEff,
    exitEfficiency: exitEff,
    byStrategy,
    byCoin,
    byMarket,
    findings,
    minimumForJudgement: MIN_FOR_JUDGEMENT,
  };
}

/** Monday of the UTC week containing a time, as YYYY-MM-DD. */
export function weekOf(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export function weeklyReviews(trips) {
  const weeks = {};
  for (const t of trips.filter((x) => x.status === 'closed')) (weeks[weekOf(t.closedAt)] ||= []).push(t);
  return Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0])).map(([week, list]) => {
    const a = analyzeTrips(list);
    const best = [...list].sort((x, y) => y.pnl - x.pnl)[0];
    const worst = [...list].sort((x, y) => x.pnl - y.pnl)[0];
    return { week, trips: list.length, wins: a.wins, pnl: a.totalPnl, fees: a.totalFees, winRatePct: a.winRatePct, best: { symbol: best.symbol, pnl: best.pnl }, worst: { symbol: worst.symbol, pnl: worst.pnl } };
  });
}

/** How well a closed trade's entry and exit sat within the price range seen while it was open. */
export function tradeTiming(trip, candles) {
  if (!candles.length) return null;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  if (high <= low) return null;
  return {
    highDuring: high,
    lowDuring: low,
    maxGainPct: (high / trip.entryPrice - 1) * 100,
    maxDrawdownPct: (1 - low / trip.entryPrice) * 100,
    entryEfficiency: Math.max(0, Math.min(1, (high - trip.entryPrice) / (high - low))),
    exitEfficiency: Math.max(0, Math.min(1, (trip.exitPrice - low) / (high - low))),
  };
}

const parseKline = (k) => ({ openTime: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), closeTime: k[6], quoteVolume: Number(k[7]), trades: k[8], takerBuyVolume: Number(k[9]) });
const intervalFor = (ms) => (ms <= 16 * 3600e3 ? '1m' : ms <= 3 * 86400e3 ? '5m' : ms <= 10 * 86400e3 ? '15m' : ms <= 41 * 86400e3 ? '1h' : '4h');

export const REVIEW_SYSTEM = `You are a trading coach reviewing a user's paper trades in a research tool. Use only the JSON in the user's message, and never invent trades.
Say plainly when the sample is too small to conclude anything. Point out patterns and what to examine next. Never promise returns or tell the user what to buy or sell. Keep it to one short paragraph.`;

export function createJournal({ pool, rest, cached }) {
  async function context(trip) {
    return cached(`journal:${trip.id}:${trip.closedAt ?? 'open'}`, trip.closedAt ? 24 * 3600e3 : 60e3, async () => {
      const out = { context: null, timing: null };
      try {
        const raw = await rest.request('/api/v3/klines', { symbol: trip.symbol, interval: '1h', endTime: trip.openedAt, limit: 300 });
        const candles = raw.map(parseKline);
        if (candles.length >= 30) {
          const snap = marketSnapshot(candles, computeAll(candles), candles.length - 1);
          out.context = { trend: snap.trend, rsi: snap.rsi, volatilityPct: snap.volatilityPct, momentumPct: snap.momentumPct, asOf: snap.asOfCandleClose };
        }
        if (trip.closedAt) {
          const duringRaw = await rest.request('/api/v3/klines', { symbol: trip.symbol, interval: intervalFor(trip.closedAt - trip.openedAt), startTime: trip.openedAt, endTime: trip.closedAt, limit: 1000 });
          out.timing = tradeTiming(trip, duringRaw.map(parseKline));
        }
      } catch (e) {
        out.error = e.message; // the journal still works without market context
      }
      return out;
    });
  }

  async function load({ limit = 25, offset = 0 } = {}) {
    const { rows: trades } = await pool.query('SELECT id, symbol, side, qty, fill_price, notional, fee, realized_pnl, created_at FROM paper_trades WHERE account_id=1 ORDER BY id');
    const { rows: notes } = await pool.query(
      `SELECT j.trade_id, j.entry_reason, j.exit_reason, j.strategy_id, j.note, j.updated_at, s.name AS strategy_name
       FROM journal_annotations j LEFT JOIN strategies s ON s.id=j.strategy_id`);
    const byTrade = new Map(notes.map((n) => [Number(n.trade_id), n]));
    const trips = buildRoundTrips(trades).map((t) => {
      const annotation = byTrade.get(Number(t.id)) || null;
      return { ...t, annotation, strategyName: annotation?.strategy_name ?? null };
    });
    // market context for the most recent trips only, to limit requests to Binance
    const newestFirst = [...trips].reverse();
    await Promise.all(newestFirst.slice(0, 30).map(async (t) => Object.assign(t, await context(t))));
    const lim = Math.max(1, Math.min(100, Number(limit) || 25));
    const off = Math.max(0, Number(offset) || 0);
    return {
      totalTrips: trips.length,
      limit: lim,
      offset: off,
      trips: newestFirst.slice(off, off + lim),
      analysis: analyzeTrips(trips),
      weekly: weeklyReviews(trips),
    };
  }

  async function annotate(tradeId, body = {}) {
    const id = Number(tradeId);
    const { rows: [trade] } = await pool.query('SELECT id FROM paper_trades WHERE id=$1', [id]);
    if (!trade) throw Object.assign(new Error('No such trade'), { status: 404 });
    const text = (v) => (v === undefined || v === null ? null : String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 1000).trim() || null);
    let strategyId = null;
    if (body.strategyId !== undefined && body.strategyId !== null && body.strategyId !== '') {
      const { rows: [s] } = await pool.query('SELECT id FROM strategies WHERE id=$1', [Number(body.strategyId)]);
      if (!s) throw Object.assign(new Error('No such strategy'), { status: 400 });
      strategyId = s.id;
    }
    const { rows: [row] } = await pool.query(
      `INSERT INTO journal_annotations (trade_id, entry_reason, exit_reason, strategy_id, note) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (trade_id) DO UPDATE SET entry_reason=$2, exit_reason=$3, strategy_id=$4, note=$5, updated_at=now() RETURNING *`,
      [id, text(body.entryReason), text(body.exitReason), strategyId, text(body.note)]);
    return row;
  }

  return { load, annotate };
}
