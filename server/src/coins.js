// The one place coins are defined. To add a coin, add a line here: the server, stream, API and
// dashboard all read this list (the client gets it from GET /api/meta). The optional SYMBOLS
// environment variable can narrow the list or add a pair not listed here.
export const COINS = [
  { symbol: 'BTCUSDT', base: 'BTC', name: 'Bitcoin', color: '#BF8420' },
  { symbol: 'ETHUSDT', base: 'ETH', name: 'Ethereum', color: '#3F8FEA' },
  { symbol: 'SOLUSDT', base: 'SOL', name: 'Solana', color: '#D9609F' },
  { symbol: 'BNBUSDT', base: 'BNB', name: 'Binance Coin', color: '#9A9A1F' },
  { symbol: 'XRPUSDT', base: 'XRP', name: 'XRP', color: '#6A7BF0' },
  { symbol: 'DOGEUSDT', base: 'DOGE', name: 'Dogecoin', color: '#D9683A' },
  { symbol: 'ADAUSDT', base: 'ADA', name: 'Cardano', color: '#B070E0' },
  { symbol: 'LINKUSDT', base: 'LINK', name: 'Chainlink', color: '#10A8A8' },
  { symbol: 'AVAXUSDT', base: 'AVAX', name: 'Avalanche', color: '#E0484F' },
  { symbol: 'LTCUSDT', base: 'LTC', name: 'Litecoin', color: '#3A9ADA' },
];

const FALLBACK_COLOR = '#8E97AB';

/** Details for a symbol, including one that only came from the SYMBOLS environment variable. */
export function coinInfo(symbol) {
  const known = COINS.find((c) => c.symbol === symbol);
  if (known) return known;
  const base = symbol.replace(/USDT$/, '');
  return { symbol, base, name: base, color: FALLBACK_COLOR };
}

export function resolveSymbols(env) {
  const list = env ? env.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : COINS.map((c) => c.symbol);
  return [...new Set(list)];
}
