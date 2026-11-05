// The dashboard's view of the coin list. The list itself lives on the server (server/src/coins.js)
// and arrives through GET /api/meta, so no coin is named anywhere in the client.
const FALLBACK_COLOR = '#8E97AB';
let bySymbol = new Map();

export function setCoins(coins = []) {
  bySymbol = new Map(coins.map((c) => [c.symbol, c]));
}

export const baseOf = (symbol) => bySymbol.get(symbol)?.base || String(symbol || '').replace(/USDT$/, '');
export const nameOf = (symbol) => bySymbol.get(symbol)?.name || baseOf(symbol);
export const pairColor = (symbol) => bySymbol.get(symbol)?.color || FALLBACK_COLOR;
