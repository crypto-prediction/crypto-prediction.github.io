// Exchange Price Comparison: read-only public quotes from several exchanges. It gives context only: it never
// touches the Binance spot feed or paper trading, and it never places a trade.
import { coinInfo } from '../coins.js';
import { fetchJson } from './http.js';

// Starting values only: fees depend on your tier and region, and they change. The page lets you set your own.
export const EXCHANGES = {
  binance: { name: 'Binance', takerFeePct: 0.1, quote: 'USDT' },
  coinbase: { name: 'Coinbase', takerFeePct: 0.6, quote: 'USD' },
  kraken: { name: 'Kraken', takerFeePct: 0.26, quote: 'USDT' },
  okx: { name: 'OKX', takerFeePct: 0.1, quote: 'USDT' },
  bybit: { name: 'Bybit', takerFeePct: 0.1, quote: 'USDT' },
};

// Rough time for the network to confirm a transfer. Exchanges often take longer.
export const NETWORK_MINUTES = { BTC: '30–60', ETH: '3–15', SOL: '1–2', BNB: '1–3', XRP: '1', DOGE: '10–30', ADA: '5–20', LINK: '3–15', AVAX: '1–3', LTC: '10–30' };

export const CAVEAT = 'A price difference is not a guaranteed profit. Moving coins between exchanges takes time, prices can close the gap first, withdrawals can be paused, and the visible book may not fill your size. Signal Lab never executes these trades.';
const SOURCE_URL = { binance: 'https://www.binance.com', coinbase: 'https://exchange.coinbase.com', kraken: 'https://pro.kraken.com', okx: 'https://www.okx.com', bybit: 'https://www.bybit.com' };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const toLevels = (rows) => rows.map((r) => [Number(r[0]), Number(r[1])]);

/** Normal shape per exchange: { bid, ask, last, volumeUsd, book: { bids, asks } }. */
export function createAdapters({ rest, fetchImpl }) {
  const get = (url) => fetchJson(fetchImpl, url);
  const krakenPair = (base) => `${base === 'BTC' ? 'XBT' : base === 'DOGE' ? 'XDG' : base}USDT`;
  return {
    async binance(base) {
      const symbol = `${base}USDT`;
      const [t, d] = await Promise.all([rest.request('/api/v3/ticker/24hr', { symbol }), rest.request('/api/v3/depth', { symbol, limit: 100 })]);
      return { bid: num(t.bidPrice), ask: num(t.askPrice), last: num(t.lastPrice), volumeUsd: num(t.quoteVolume), book: { bids: toLevels(d.bids), asks: toLevels(d.asks) } };
    },
    async coinbase(base) {
      const id = `${base}-USD`;
      const [t, d] = await Promise.all([
        get(`https://api.exchange.coinbase.com/products/${id}/ticker`),
        get(`https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${id}&limit=200`).catch(() => null),
      ]);
      const last = num(t.price);
      const book = d?.pricebook ? { bids: d.pricebook.bids.map((x) => [Number(x.price), Number(x.size)]), asks: d.pricebook.asks.map((x) => [Number(x.price), Number(x.size)]) } : null;
      return { bid: num(t.bid), ask: num(t.ask), last, volumeUsd: last !== null && num(t.volume) !== null ? num(t.volume) * last : null, book };
    },
    async kraken(base) {
      const pair = krakenPair(base);
      const [t, d] = await Promise.all([get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`), get(`https://api.kraken.com/0/public/Depth?pair=${pair}&count=200`)]);
      if (t.error?.length) throw new Error(/Unknown asset pair/.test(t.error[0]) ? 'Not listed' : t.error[0]);
      const x = Object.values(t.result)[0];
      const b = Object.values(d.result)[0];
      const last = num(x.c[0]);
      return { bid: num(x.b[0]), ask: num(x.a[0]), last, volumeUsd: last !== null && num(x.v[1]) !== null ? num(x.v[1]) * last : null, book: { bids: toLevels(b.bids), asks: toLevels(b.asks) } };
    },
    async okx(base) {
      const id = `${base}-USDT`;
      const [t, d] = await Promise.all([get(`https://www.okx.com/api/v5/market/ticker?instId=${id}`), get(`https://www.okx.com/api/v5/market/books?instId=${id}&sz=200`)]);
      if (t.code !== '0' || !t.data?.[0]) throw new Error(t.code === '51001' ? 'Not listed' : t.msg || 'No data');
      const x = t.data[0];
      const b = d.data?.[0];
      return { bid: num(x.bidPx), ask: num(x.askPx), last: num(x.last), volumeUsd: num(x.volCcy24h), book: b ? { bids: toLevels(b.bids), asks: toLevels(b.asks) } : null };
    },
    async bybit(base) {
      const symbol = `${base}USDT`;
      const [t, d] = await Promise.all([get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${symbol}`), get(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${symbol}&limit=200`)]);
      if (t.retCode !== 0 || !t.result?.list?.[0]) throw new Error(/symbol/i.test(t.retMsg || '') ? 'Not listed' : t.retMsg || 'No data');
      const x = t.result.list[0];
      return { bid: num(x.bid1Price), ask: num(x.ask1Price), last: num(x.lastPrice), volumeUsd: num(x.turnover24h), book: d.result ? { bids: toLevels(d.result.b), asks: toLevels(d.result.a) } : null };
    },
    async usdtUsd() {
      const t = await get('https://api.exchange.coinbase.com/products/USDT-USD/ticker');
      return num(t.price);
    },
  };
}

/** Walks the visible book for a buy or sell of `usd`. `levels` are best first. */
export function walkBook(levels, usd) {
  if (!levels?.length) return null;
  let left = usd, spent = 0, qty = 0;
  for (const [price, size] of levels) {
    const here = Math.min(left, price * size);
    spent += here;
    qty += here / price;
    left -= here;
    if (left <= 1e-9) break;
  }
  if (!qty) return null;
  const avg = spent / qty;
  return { avgPrice: avg, filledUsd: spent, complete: left <= 1e-9, slippagePct: (Math.abs(avg - levels[0][0]) / levels[0][0]) * 100 };
}

const depthWithin = (levels, mid, pct, side) => (levels || [])
  .filter(([p]) => (side === 'bid' ? p >= mid * (1 - pct / 100) : p <= mid * (1 + pct / 100)))
  .reduce((s, [p, q]) => s + p * q, 0);

/**
 * quotes: { exchangeId: quote | { error } }. Prices are compared in USDT: USD-quoted exchanges are converted with the
 * real USDT/USD rate, and left out of the cost comparison if that rate is missing.
 */
export function compareQuotes(quotes, { tradeUsd = 1000, feesPct = {}, withdrawalFeeUsd = 0, usdtUsd = null, base = '' } = {}) {
  const rows = Object.entries(quotes).map(([id, q]) => {
    const meta = EXCHANGES[id];
    const feePct = Number.isFinite(feesPct[id]) ? feesPct[id] : meta.takerFeePct;
    if (q.error) return { id, name: meta.name, url: SOURCE_URL[id], feePct, error: q.error };
    const rate = meta.quote === 'USD' ? usdtUsd : 1;
    const conv = (v) => (v === null || !rate ? null : v / rate);
    const bid = conv(q.bid), ask = conv(q.ask), last = conv(q.last);
    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
    const scale = rate ? 1 / rate : null;
    const asUsdt = (levels) => (levels && scale ? levels.map(([p, s]) => [p * scale, s]) : null);
    const buy = walkBook(asUsdt(q.book?.asks), tradeUsd);
    const sell = walkBook(asUsdt(q.book?.bids), tradeUsd);
    return {
      id, name: meta.name, url: SOURCE_URL[id], feePct, quote: meta.quote,
      converted: meta.quote === 'USD' && Boolean(rate),
      bid, ask, last, mid,
      volumeUsd: q.volumeUsd,
      spreadBps: bid !== null && ask !== null && mid ? ((ask - bid) / mid) * 1e4 : null,
      liquidity: q.book && mid ? { bidUsd: depthWithin(asUsdt(q.book.bids), mid, 0.5, 'bid'), askUsd: depthWithin(asUsdt(q.book.asks), mid, 0.5, 'ask') } : null,
      buy, sell,
      buyCostPct: buy ? buy.slippagePct + feePct : null,
    };
  });

  const usable = rows.filter((r) => !r.error && r.bid !== null && r.ask !== null);
  const reference = rows.find((r) => r.id === 'binance' && !r.error) || usable[0];
  for (const r of rows) {
    if (r.error || r.last === null || !reference?.last) continue;
    r.diffUsdt = r.last - reference.last;
    r.diffPct = (r.last / reference.last - 1) * 100;
  }

  let opportunity = null;
  if (usable.length >= 2) {
    const buyAt = usable.reduce((a, b) => (b.ask < a.ask ? b : a));
    const sellAt = usable.filter((r) => r.id !== buyAt.id).reduce((a, b) => (b.bid > a.bid ? b : a));
    const grossPct = (sellAt.bid / buyAt.ask - 1) * 100;
    const slippagePct = (buyAt.buy?.slippagePct ?? 0) + (sellAt.sell?.slippagePct ?? 0);
    const feePct = buyAt.feePct + sellAt.feePct;
    const withdrawalPct = tradeUsd > 0 ? (withdrawalFeeUsd / tradeUsd) * 100 : 0;
    const netPct = grossPct - feePct - slippagePct - withdrawalPct;
    opportunity = {
      buyAt: buyAt.name, sellAt: sellAt.name, buyPrice: buyAt.ask, sellPrice: sellAt.bid,
      grossPct, feePct, slippagePct, withdrawalPct, netPct,
      netUsd: (netPct / 100) * tradeUsd,
      tradeUsd,
      fillsCompletely: Boolean(buyAt.buy?.complete && sellAt.sell?.complete),
      networkMinutes: NETWORK_MINUTES[base] ?? null,
    };
  }
  return { rows, opportunity, referenceExchange: reference?.name ?? null };
}

export function createExchanges({ rest, cached, fetchImpl = globalThis.fetch }) {
  const adapters = createAdapters({ rest, fetchImpl });

  async function compare(symbol, { tradeUsd = 1000, feesPct = {}, withdrawalFeeUsd = 0, exchanges = Object.keys(EXCHANGES) } = {}) {
    const base = coinInfo(symbol).base;
    const selected = exchanges.filter((id) => EXCHANGES[id]);
    if (!selected.length) throw Object.assign(new Error('Choose at least one exchange'), { status: 400 });
    const load = (id) => cached(`xq:${id}:${base}`, 15000, () => adapters[id](base))
      .catch((e) => ({ error: e.httpStatus === 404 || e.httpStatus === 400 ? 'Not listed' : e.message }));
    const [usdtUsd, ...results] = await Promise.all([
      cached('xq:usdtusd', 60000, () => adapters.usdtUsd()).catch(() => null),
      ...selected.map(load),
    ]);
    const quotes = Object.fromEntries(selected.map((id, i) => [id, results[i]]));
    return {
      symbol, base, fetchedAt: Date.now(), usdtUsd,
      ...compareQuotes(quotes, { tradeUsd, feesPct, withdrawalFeeUsd, usdtUsd, base }),
      caveat: CAVEAT,
      feeNote: 'Fees are starting values for the entry tier, gathered from secondary sources. They depend on your tier and region, so set your own.',
    };
  }

  return { compare };
}
