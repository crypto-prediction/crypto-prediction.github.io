// Heatmap rows and filters. No React or browser APIs, so this is unit tested directly.
export const HEATMAP_FILTERS = [
  ['all', 'All'], ['gainers', 'Top gainers'], ['losers', 'Top losers'], ['volume', 'Highest volume'],
  ['volatility', 'Highest volatility'], ['bullish', 'Bullish signals'], ['bearish', 'Bearish signals'],
];

/** One row per coin. Missing readings stay null; filters only ever remove or reorder real rows. */
export function heatmapRows(symbols, tickers, overview, filter = 'all') {
  const rows = symbols.map((symbol) => {
    const t = tickers?.[symbol];
    const o = overview?.[symbol];
    return {
      symbol,
      price: t?.lastPrice ?? null,
      change: t?.priceChangePercent ?? null,
      volume: t?.quoteVolume ?? null,
      volatility: o?.volatilityPct ?? null,
      trend: o?.trend ?? null,
      signal: o?.signal ?? null,
    };
  });
  const largestFirst = (key) => (a, b) => b[key] - a[key];
  switch (filter) {
    case 'gainers': return rows.filter((r) => r.change > 0).sort(largestFirst('change'));
    case 'losers': return rows.filter((r) => r.change !== null && r.change < 0).sort((a, b) => a.change - b.change);
    case 'volume': return rows.filter((r) => r.volume !== null).sort(largestFirst('volume'));
    case 'volatility': return rows.filter((r) => r.volatility !== null).sort(largestFirst('volatility'));
    case 'bullish': return rows.filter((r) => r.signal === 'BUY' || r.trend === 'Uptrend');
    case 'bearish': return rows.filter((r) => r.signal === 'SELL' || r.trend === 'Downtrend');
    default: return rows;
  }
}
