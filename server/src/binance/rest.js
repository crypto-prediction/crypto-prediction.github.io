// Binance public market-data REST client.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints
import { config, INTERVALS } from '../config.js';

export class BinanceError extends Error {
  constructor(message, { status = 0, code = 'binance_error', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'BinanceError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBinanceRest({ baseUrl = config.binanceRest, fetchImpl = globalThis.fetch, maxRetries = 3, timeoutMs = 10000, now = () => Date.now() } = {}) {
  let bannedUntil = 0;
  let usedWeight = 0;

  async function request(path, params = {}) {
    if (now() < bannedUntil) {
      throw new BinanceError(`Binance rate limit: requests paused for ${Math.ceil((bannedUntil - now()) / 1000)}s`, {
        status: 429, code: 'rate_limited', retryable: true, retryAfterMs: bannedUntil - now(),
      });
    }
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        clearTimeout(timer);
        const w = res.headers.get('x-mbx-used-weight-1m');
        if (w) usedWeight = Number(w);
        if (res.status === 429 || res.status === 418) {
          const ra = Number(res.headers.get('retry-after') || 0) * 1000 || 60000;
          bannedUntil = now() + ra;
          throw new BinanceError(res.status === 418 ? 'Binance has temporarily banned this IP for exceeding rate limits' : 'Binance rate limit reached', {
            status: res.status, code: 'rate_limited', retryable: false, retryAfterMs: ra,
          });
        }
        if (res.status === 451) {
          throw new BinanceError('Binance is not available from this location (HTTP 451). Set BINANCE_REST_URL=https://data-api.binance.vision', { status: 451, code: 'restricted_location' });
        }
        if (!res.ok) {
          let body = {};
          try { body = await res.json(); } catch { /* not JSON */ }
          const retryable = res.status >= 500;
          throw new BinanceError(body.msg ? `Binance error ${body.code}: ${body.msg}` : `Binance HTTP ${res.status}`, { status: res.status, code: retryable ? 'upstream_error' : 'bad_request', retryable });
        }
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        lastErr = err instanceof BinanceError ? err
          : new BinanceError(err.name === 'AbortError' ? `Binance request timed out after ${timeoutMs}ms` : `Cannot reach Binance: ${err.message}`, { code: 'network_error', retryable: true });
        if (!lastErr.retryable || attempt === maxRetries) throw lastErr;
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  function parseKline(k, nowMs) {
    return {
      openTime: k[0],
      open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
      quoteVolume: Number(k[7]),
      trades: k[8],
      takerBuyVolume: Number(k[9]),
      closed: k[6] < nowMs,
    };
  }

  function checkArgs(symbol, interval) {
    if (!config.symbols.includes(symbol)) throw new BinanceError(`Unsupported symbol ${symbol}`, { status: 400, code: 'bad_request' });
    if (!INTERVALS.includes(interval)) throw new BinanceError(`Unsupported interval ${interval}`, { status: 400, code: 'bad_request' });
  }

  /** Most recent `limit` candles (<=1000). The last one may still be open (closed=false). */
  async function klines(symbol, interval, limit = 500) {
    checkArgs(symbol, interval);
    const raw = await request('/api/v3/klines', { symbol, interval, limit: Math.min(1000, limit) });
    const t = now();
    return raw.map((k) => parseKline(k, t));
  }

  /** Up to `total` most recent candles, paging backwards 1000 at a time. */
  async function history(symbol, interval, total = 1000) {
    checkArgs(symbol, interval);
    total = Math.min(total, 5000);
    let out = [];
    let endTime;
    while (out.length < total) {
      const limit = Math.min(1000, total - out.length);
      const raw = await request('/api/v3/klines', { symbol, interval, limit, endTime });
      if (!raw.length) break;
      const t = now();
      const page = raw.map((k) => parseKline(k, t));
      out = page.concat(out);
      endTime = page[0].openTime - 1;
      if (raw.length < limit) break;
    }
    // de-duplicate by openTime just in case pages overlap
    const seen = new Set();
    return out.filter((c) => (seen.has(c.openTime) ? false : seen.add(c.openTime)));
  }

  async function tickers24h(symbols = config.symbols) {
    const raw = await request('/api/v3/ticker/24hr', { symbols: JSON.stringify(symbols) });
    return raw.map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      priceChange: Number(t.priceChange),
      priceChangePercent: Number(t.priceChangePercent),
      highPrice: Number(t.highPrice),
      lowPrice: Number(t.lowPrice),
      volume: Number(t.volume),
      quoteVolume: Number(t.quoteVolume),
      closeTime: t.closeTime,
    }));
  }

  /** Pairs Binance currently allows for spot trading. Weight 20, so it is called rarely. */
  async function tradableSymbols() {
    const raw = await request('/api/v3/exchangeInfo', { permissions: 'SPOT', symbolStatus: 'TRADING', showPermissionSets: false });
    return new Set(raw.symbols.filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed !== false).map((s) => s.symbol));
  }

  async function price(symbol) {
    if (!config.symbols.includes(symbol)) throw new BinanceError(`Unsupported symbol ${symbol}`, { status: 400, code: 'bad_request' });
    const raw = await request('/api/v3/ticker/price', { symbol });
    return { price: Number(raw.price), eventTime: now() };
  }

  return { request, klines, history, tickers24h, tradableSymbols, price, status: () => ({ usedWeight, bannedUntil }) };
}
