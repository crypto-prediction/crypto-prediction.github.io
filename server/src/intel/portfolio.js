// Read-only analysis of the paper account. Nothing in this file writes to the database.

/** Pearson correlation, or null when it can't be measured. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

export function maxDrawdown(values) {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst * 100;
}

const std = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/**
 * Exposure, risk and correlation. returnsBySymbol holds real candle returns, oldest first, all ending at the same candle.
 */
export function analyzePortfolio(pf, equity, returnsBySymbol, candlesPerDay) {
  const symbols = Object.keys(returnsBySymbol);
  const value = pf.equity;
  const exposure = pf.positions.map((p) => ({
    symbol: p.symbol,
    marketValue: p.marketValue,
    sharePct: value && p.marketValue !== null ? (p.marketValue / value) * 100 : null,
    unrealizedPnl: p.unrealizedPnl,
    realizedPnl: p.realizedPnl,
    feesPaid: p.feesPaid,
  })).sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
  const invested = pf.marketValue;

  // portfolio volatility from the real history of the coins held, at their current weights
  let portfolioVolPct = null;
  if (pf.allPositionsPriced && value && pf.positions.length) {
    const held = pf.positions.filter((p) => returnsBySymbol[p.symbol]);
    const len = Math.min(...held.map((p) => returnsBySymbol[p.symbol].length));
    if (held.length && len >= 2) {
      const combined = Array.from({ length: len }, (_, k) => held.reduce((sum, p) => {
        const r = returnsBySymbol[p.symbol];
        return sum + (p.marketValue / value) * r[r.length - len + k];
      }, 0));
      portfolioVolPct = std(combined) * Math.sqrt(candlesPerDay) * 100;
    }
  }
  const equityValues = equity.map((e) => e.equity);
  const heldSet = new Set(pf.positions.map((p) => p.symbol));

  return {
    totalValue: value,
    cash: pf.cash,
    realizedPnl: pf.realizedPnl,
    unrealizedPnl: pf.allPositionsPriced ? pf.positions.reduce((s, p) => s + p.unrealizedPnl, 0) : null,
    feesPaid: pf.feesPaid,
    exposure,
    risk: {
      investedPct: value && invested !== null ? (invested / value) * 100 : null,
      largestPositionPct: exposure.length ? exposure[0].sharePct : 0,
      positions: exposure.length,
      dailyVolatilityPct: portfolioVolPct,
      maxDrawdownPct: equityValues.length >= 2 ? maxDrawdown(equityValues) : null,
      pricesLive: pf.allPositionsPriced,
    },
    history: { points: equity.length, first: equity[0] ?? null, last: equity[equity.length - 1] ?? null },
    correlation: {
      symbols,
      held: symbols.filter((s) => heldSet.has(s)),
      matrix: symbols.map((a) => symbols.map((b) => {
        const x = returnsBySymbol[a], y = returnsBySymbol[b];
        const n = Math.min(x.length, y.length);
        const c = correlation(x.slice(-n), y.slice(-n));
        return c === null ? null : Number(c.toFixed(3));
      })),
    },
  };
}
