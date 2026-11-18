// The demo's paper account: the same rules as the server's paper.js, stored only in this visitor's browser.
// Fills use a real Binance price, or the order is refused. Nobody else can see or change it.

const KEY = 'signal-lab-demo-paper-v1';
const ACCOUNT = 1;
const EPS = 1e-9;

export class PaperError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fresh = (startingBalance) => ({ startingBalance, cash: startingBalance, positions: {}, trades: [], equity: [], resetAt: new Date().toISOString(), nextId: 1 });

export function createPaper({ getPrice, isTradable, feeRate = 0.001, slippageBps = 5, startingBalance = 10000, storage = globalThis.localStorage }) {
  const load = () => {
    try {
      const s = JSON.parse(storage?.getItem(KEY) || 'null');
      if (s && typeof s.cash === 'number') return s;
    } catch { /* unreadable storage starts a new account */ }
    return fresh(startingBalance);
  };
  let s = load();
  const save = () => { try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: kept for this visit only */ } };

  async function order({ symbol, side, amountUsd, qty, closeAll }) {
    side = String(side || '').toUpperCase();
    if (!isTradable(symbol)) throw new PaperError(`Unsupported symbol ${symbol}`);
    if (side !== 'BUY' && side !== 'SELL') throw new PaperError('side must be BUY or SELL');
    const q = await getPrice(symbol);
    const slip = slippageBps / 10000;
    const now = new Date().toISOString();
    const pos = s.positions[symbol];
    const base = { id: s.nextId++, account_id: ACCOUNT, symbol, market_price: q.price, slippage_bps: slippageBps, price_source: q.source, price_time: new Date(q.time).toISOString(), created_at: now };
    let trade;

    if (side === 'BUY') {
      const amt = Number(amountUsd);
      if (!(amt >= 1)) throw new PaperError('Enter an amount of at least $1');
      if (amt > s.cash + EPS) throw new PaperError(`Not enough paper cash: you have $${s.cash.toFixed(2)}`);
      const fill = q.price * (1 + slip);
      const fee = amt * feeRate;
      const boughtQty = (amt - fee) / fill;
      s.cash -= amt;
      if (pos) {
        const newQty = pos.qty + boughtQty;
        pos.avg_price = (pos.avg_price * pos.qty + fill * boughtQty) / newQty;
        pos.qty = newQty;
        pos.cost_basis += amt;
      } else {
        s.positions[symbol] = { qty: boughtQty, avg_price: fill, cost_basis: amt, opened_at: now };
      }
      trade = { ...base, side: 'BUY', qty: boughtQty, fill_price: fill, notional: boughtQty * fill, fee, entry_price: null, realized_pnl: null };
    } else {
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
      const remaining = pos.qty - sellQty;
      s.cash += net;
      if (remaining * q.price < 0.01) delete s.positions[symbol];
      else { pos.qty = remaining; pos.cost_basis -= basisPart; }
      trade = { ...base, side: 'SELL', qty: sellQty, fill_price: fill, notional: gross, fee, entry_price: pos.avg_price, realized_pnl: net - basisPart };
    }
    s.trades.push(trade);
    save();
    return trade;
  }

  function portfolio(priceLookup) {
    const stats = {};
    let fees = 0, realized = 0, closes = 0, wins = 0;
    for (const t of s.trades) {
      const r = (stats[t.symbol] ||= { realized: 0, fees: 0, trades: 0 });
      r.fees += t.fee; r.trades++; fees += t.fee;
      if (t.side === 'SELL') { r.realized += t.realized_pnl; realized += t.realized_pnl; closes++; if (t.realized_pnl > 0) wins++; }
    }
    let marketValue = 0, priced = true;
    const positions = Object.keys(s.positions).sort().map((symbol) => {
      const p = s.positions[symbol];
      const live = priceLookup(symbol);
      if (!live) priced = false;
      const mv = live ? p.qty * live.price : null;
      if (mv !== null) marketValue += mv;
      return {
        symbol, qty: p.qty, avgPrice: p.avg_price, costBasis: p.cost_basis, openedAt: p.opened_at,
        livePrice: live?.price ?? null, priceTime: live?.eventTime ?? null,
        marketValue: mv, unrealizedPnl: mv === null ? null : mv - p.cost_basis,
        unrealizedPct: mv === null ? null : (mv / p.cost_basis - 1) * 100,
        realizedPnl: stats[symbol]?.realized ?? 0, feesPaid: stats[symbol]?.fees ?? 0, trades: stats[symbol]?.trades ?? 0,
      };
    });
    const closedCoins = Object.keys(stats).sort().filter((sym) => !s.positions[sym])
      .map((sym) => ({ symbol: sym, realizedPnl: stats[sym].realized, feesPaid: stats[sym].fees, trades: stats[sym].trades }));
    const equity = priced ? s.cash + marketValue : null;
    return {
      mode: 'paper', startingBalance: s.startingBalance, cash: s.cash, positions, closedCoins,
      marketValue: priced ? marketValue : null, equity,
      totalPnl: equity === null ? null : equity - s.startingBalance,
      totalPnlPct: equity === null ? null : (equity / s.startingBalance - 1) * 100,
      realizedPnl: realized, feesPaid: fees, trades: s.trades.length, closedTrades: closes,
      winRatePct: closes ? (wins / closes) * 100 : null, allPositionsPriced: priced,
      feeRatePct: feeRate * 100, slippageBps, since: s.resetAt,
    };
  }

  const trades = (limit = 100) => [...s.trades].reverse().slice(0, Math.min(500, limit));

  /** Never stores an equity value that couldn't be priced. One point a minute at most. */
  function snapshot(priceLookup) {
    const p = portfolio(priceLookup);
    if (p.equity === null) return;
    const last = s.equity.at(-1);
    if (last && Date.now() - Date.parse(last.ts) < 60000) return;
    s.equity.push({ ts: new Date().toISOString(), equity: p.equity });
    if (s.equity.length > 5000) s.equity = s.equity.slice(-5000);
    save();
  }

  function reset() {
    s = fresh(startingBalance);
    save();
  }

  return { order, portfolio, trades, snapshot, equityHistory: () => s.equity, reset };
}
