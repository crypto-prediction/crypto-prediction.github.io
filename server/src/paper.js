// Paper trading against real Binance prices. No exchange connection, no real orders.
import { tx } from './tx.js';
import { config } from './config.js';

const ACCOUNT = 1;
const EPS = 1e-9;

export class PaperError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * @param pool pg Pool
 * @param getPrice async (symbol) => { price, time, source }  -- must return a REAL market price or throw
 */
export function createPaper(pool, getPrice, { feeRate = config.paper.feeRate, slippageBps = config.paper.slippageBps, isTradable = (s) => config.symbols.includes(s) } = {}) {
  async function order({ symbol, side, amountUsd, qty, closeAll }) {
    side = String(side || '').toUpperCase();
    if (!isTradable(symbol)) throw new PaperError(`Unsupported symbol ${symbol}`);
    if (side !== 'BUY' && side !== 'SELL') throw new PaperError('side must be BUY or SELL');
    const q = await getPrice(symbol); // throws if no live price
    const slip = slippageBps / 10000;

    return tx(pool, async (db) => {
      const { rows: [acct] } = await db.query('SELECT * FROM paper_accounts WHERE id=$1 FOR UPDATE', [ACCOUNT]);
      const { rows: [pos] } = await db.query('SELECT * FROM paper_positions WHERE account_id=$1 AND symbol=$2 FOR UPDATE', [ACCOUNT, symbol]);

      if (side === 'BUY') {
        const amt = Number(amountUsd);
        if (!(amt >= 1)) throw new PaperError('Enter an amount of at least $1');
        if (amt > acct.cash + EPS) throw new PaperError(`Not enough paper cash: you have $${acct.cash.toFixed(2)}`);
        const fill = q.price * (1 + slip);
        const fee = amt * feeRate;
        const boughtQty = (amt - fee) / fill;
        const notional = boughtQty * fill;
        await db.query('UPDATE paper_accounts SET cash = cash - $1 WHERE id=$2', [amt, ACCOUNT]);
        if (pos) {
          const newQty = pos.qty + boughtQty;
          await db.query('UPDATE paper_positions SET qty=$1, avg_price=$2, cost_basis=cost_basis+$3 WHERE account_id=$4 AND symbol=$5',
            [newQty, (pos.avg_price * pos.qty + fill * boughtQty) / newQty, amt, ACCOUNT, symbol]);
        } else {
          await db.query('INSERT INTO paper_positions (account_id, symbol, qty, avg_price, cost_basis) VALUES ($1,$2,$3,$4,$5)',
            [ACCOUNT, symbol, boughtQty, fill, amt]);
        }
        const { rows: [t] } = await db.query(
          `INSERT INTO paper_trades (account_id, symbol, side, qty, market_price, fill_price, notional, fee, slippage_bps, price_source, price_time)
           VALUES ($1,$2,'BUY',$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0)) RETURNING *`,
          [ACCOUNT, symbol, boughtQty, q.price, fill, notional, fee, slippageBps, q.source, q.time]);
        return t;
      }

      // SELL
      if (!pos || pos.qty <= EPS) throw new PaperError(`You hold no ${symbol} in the paper account`);
      let sellQty;
      if (closeAll) sellQty = pos.qty;
      else if (qty !== undefined) sellQty = Number(qty);
      else sellQty = Number(amountUsd) / q.price;
      if (!(sellQty > 0)) throw new PaperError('Enter an amount to sell');
      if (sellQty > pos.qty * (1 + 1e-9)) throw new PaperError(`You hold only ${pos.qty.toFixed(6)} ${symbol}`);
      sellQty = Math.min(sellQty, pos.qty);
      const fill = q.price * (1 - slip);
      const gross = sellQty * fill;
      const fee = gross * feeRate;
      const net = gross - fee;
      const basisPart = pos.cost_basis * (sellQty / pos.qty);
      const pnl = net - basisPart;
      const remaining = pos.qty - sellQty;
      await db.query('UPDATE paper_accounts SET cash = cash + $1 WHERE id=$2', [net, ACCOUNT]);
      if (remaining * q.price < 0.01) {
        await db.query('DELETE FROM paper_positions WHERE account_id=$1 AND symbol=$2', [ACCOUNT, symbol]);
      } else {
        await db.query('UPDATE paper_positions SET qty=$1, cost_basis=cost_basis-$2 WHERE account_id=$3 AND symbol=$4', [remaining, basisPart, ACCOUNT, symbol]);
      }
      const { rows: [t] } = await db.query(
        `INSERT INTO paper_trades (account_id, symbol, side, qty, market_price, fill_price, notional, fee, slippage_bps, entry_price, realized_pnl, price_source, price_time)
         VALUES ($1,$2,'SELL',$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0)) RETURNING *`,
        [ACCOUNT, symbol, sellQty, q.price, fill, gross, fee, slippageBps, pos.avg_price, pnl, q.source, q.time]);
      return t;
    }).then(async (t) => { await snapshot(); return t; });
  }

  /** Positions valued at live prices. A position whose price is unavailable is flagged, not guessed. */
  async function portfolio(priceLookup) {
    const { rows: [acct] } = await pool.query('SELECT * FROM paper_accounts WHERE id=$1', [ACCOUNT]);
    const { rows: positions } = await pool.query('SELECT * FROM paper_positions WHERE account_id=$1 ORDER BY symbol', [ACCOUNT]);
    const { rows: [agg] } = await pool.query(
      `SELECT COALESCE(SUM(fee),0) AS fees, COALESCE(SUM(realized_pnl),0) AS realized, COUNT(*)::int AS trades,
              COUNT(*) FILTER (WHERE side='SELL')::int AS closes, COUNT(*) FILTER (WHERE side='SELL' AND realized_pnl>0)::int AS wins
       FROM paper_trades WHERE account_id=$1`, [ACCOUNT]);
    const { rows: bySymbol } = await pool.query(
      `SELECT symbol, COALESCE(SUM(realized_pnl),0) AS realized, COALESCE(SUM(fee),0) AS fees, COUNT(*)::int AS trades
       FROM paper_trades WHERE account_id=$1 GROUP BY symbol ORDER BY symbol`, [ACCOUNT]);
    const tradeStats = Object.fromEntries(bySymbol.map((r) => [r.symbol, r]));
    let marketValue = 0, priced = true;
    const pos = positions.map((p) => {
      const live = priceLookup(p.symbol);
      if (!live) priced = false;
      const mv = live ? p.qty * live.price : null;
      if (mv !== null) marketValue += mv;
      return {
        symbol: p.symbol, qty: p.qty, avgPrice: p.avg_price, costBasis: p.cost_basis, openedAt: p.opened_at,
        livePrice: live?.price ?? null, priceTime: live?.eventTime ?? null,
        marketValue: mv, unrealizedPnl: mv === null ? null : mv - p.cost_basis,
        unrealizedPct: mv === null ? null : (mv / p.cost_basis - 1) * 100,
        realizedPnl: tradeStats[p.symbol]?.realized ?? 0,
        feesPaid: tradeStats[p.symbol]?.fees ?? 0,
        trades: tradeStats[p.symbol]?.trades ?? 0,
      };
    });
    // coins traded earlier with no open position still carry realised P&L and fees
    const closedCoins = bySymbol.filter((r) => !positions.some((p) => p.symbol === r.symbol))
      .map((r) => ({ symbol: r.symbol, realizedPnl: r.realized, feesPaid: r.fees, trades: r.trades }));
    const equity = priced ? acct.cash + marketValue : null;
    return {
      mode: 'paper',
      startingBalance: acct.starting_balance,
      cash: acct.cash,
      positions: pos,
      closedCoins,
      marketValue: priced ? marketValue : null,
      equity,
      totalPnl: equity === null ? null : equity - acct.starting_balance,
      totalPnlPct: equity === null ? null : (equity / acct.starting_balance - 1) * 100,
      realizedPnl: agg.realized,
      feesPaid: agg.fees,
      trades: agg.trades,
      closedTrades: agg.closes,
      winRatePct: agg.closes ? (agg.wins / agg.closes) * 100 : null,
      allPositionsPriced: priced,
      feeRatePct: feeRate * 100,
      slippageBps,
      since: acct.reset_at,
    };
  }

  async function trades(limit = 100) {
    const { rows } = await pool.query('SELECT * FROM paper_trades WHERE account_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2', [ACCOUNT, Math.min(500, limit)]);
    return rows;
  }

  let lastPriceLookup = null;
  async function snapshot(priceLookup = lastPriceLookup) {
    if (priceLookup) lastPriceLookup = priceLookup;
    if (!lastPriceLookup) return;
    const p = await portfolio(lastPriceLookup);
    if (p.equity === null) return; // never store an equity value we couldn't price
    await pool.query('INSERT INTO paper_equity (account_id, ts, equity) VALUES ($1, now(), $2) ON CONFLICT DO NOTHING', [ACCOUNT, p.equity]);
  }

  async function equityHistory() {
    const { rows } = await pool.query(
      `SELECT ts, equity FROM paper_equity WHERE account_id=$1 AND ts >= (SELECT reset_at FROM paper_accounts WHERE id=$1) ORDER BY ts LIMIT 5000`, [ACCOUNT]);
    return rows;
  }

  async function reset() {
    await tx(pool, async (db) => {
      await db.query('DELETE FROM paper_trades WHERE account_id=$1', [ACCOUNT]);
      await db.query('DELETE FROM paper_positions WHERE account_id=$1', [ACCOUNT]);
      await db.query('DELETE FROM paper_equity WHERE account_id=$1', [ACCOUNT]);
      await db.query('UPDATE paper_accounts SET cash=starting_balance, reset_at=now() WHERE id=$1', [ACCOUNT]);
    });
  }

  return { order, portfolio, trades, snapshot, equityHistory, reset };
}
