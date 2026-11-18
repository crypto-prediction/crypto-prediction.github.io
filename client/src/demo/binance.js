// Binance public market data, called straight from the visitor's browser for the online demo.
// The same endpoints the server uses. If the main address is blocked (HTTP 451, or unreachable),
// it switches to Binance's public market-data mirror.

export const SOURCE = 'Binance spot public market data';
const SPOT = ['https://api.binance.com', 'https://data-api.binance.vision'];
const SPOT_WS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision'];
const FUTURES = 'https://fapi.binance.com';

export class BinanceError extends Error {
  constructor(message, { status = 503, code = 'binance_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let spotIndex = 0;
let usedWeight = 0;
let pausedUntil = 0;

export function createRest({ futures = false } = {}) {
  async function request(path, params = {}) {
    if (Date.now() < pausedUntil) throw new BinanceError(`Binance rate limit: paused for ${Math.ceil((pausedUntil - Date.now()) / 1000)}s`, { status: 429, code: 'rate_limited' });
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = futures ? FUTURES : SPOT[spotIndex];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { signal: ctrl.signal });
        clearTimeout(timer);
        const w = res.headers.get('x-mbx-used-weight-1m');
        if (w) usedWeight = Number(w);
        if (res.status === 429 || res.status === 418) {
          pausedUntil = Date.now() + (Number(res.headers.get('retry-after') || 0) * 1000 || 60000);
          throw new BinanceError('Binance rate limit reached', { status: 429, code: 'rate_limited' });
        }
        if (res.status === 451) {
          if (!futures && spotIndex < SPOT.length - 1) { spotIndex++; continue; }
          throw new BinanceError(futures ? 'Binance futures data is not available from your location (HTTP 451)' : 'Binance is not available from your location (HTTP 451)', { status: 451, code: 'restricted' });
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new BinanceError(body.msg ? `Binance error ${body.code}: ${body.msg}` : `Binance HTTP ${res.status}`, { status: res.status >= 500 ? 503 : 400 });
        }
        return await res.json();
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof BinanceError && e.code !== 'binance_error') throw e;
        lastErr = e instanceof BinanceError ? e : new BinanceError(e.name === 'AbortError' ? 'Binance request timed out' : `Cannot reach Binance: ${e.message}`);
        // an unreachable main address may be blocked, so the mirror is tried next
        if (!futures && !(e instanceof BinanceError) && spotIndex < SPOT.length - 1) spotIndex++;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  const parseKline = (k, nowMs) => ({
    openTime: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5]), closeTime: k[6], quoteVolume: Number(k[7]), trades: k[8], takerBuyVolume: Number(k[9]),
    closed: k[6] < nowMs,
  });

  async function klines(symbol, interval, limit = 500) {
    const raw = await request('/api/v3/klines', { symbol, interval, limit: Math.min(1000, limit) });
    const t = Date.now();
    return raw.map((k) => parseKline(k, t));
  }

  async function history(symbol, interval, total = 1000) {
    total = Math.min(total, 5000);
    let out = [];
    let endTime;
    while (out.length < total) {
      const limit = Math.min(1000, total - out.length);
      const raw = await request('/api/v3/klines', { symbol, interval, limit, endTime });
      if (!raw.length) break;
      const t = Date.now();
      const page = raw.map((k) => parseKline(k, t));
      out = page.concat(out);
      endTime = page[0].openTime - 1;
      if (raw.length < limit) break;
    }
    const seen = new Set();
    return out.filter((c) => (seen.has(c.openTime) ? false : seen.add(c.openTime)));
  }

  async function tickers24h(symbols) {
    const raw = await request('/api/v3/ticker/24hr', { symbols: JSON.stringify(symbols) });
    return raw.map((t) => ({
      symbol: t.symbol, lastPrice: Number(t.lastPrice), priceChange: Number(t.priceChange), priceChangePercent: Number(t.priceChangePercent),
      highPrice: Number(t.highPrice), lowPrice: Number(t.lowPrice), volume: Number(t.volume), quoteVolume: Number(t.quoteVolume), closeTime: t.closeTime,
    }));
  }

  async function price(symbol) {
    const raw = await request('/api/v3/ticker/price', { symbol });
    return { price: Number(raw.price), eventTime: Date.now() };
  }

  return { request, klines, history, tickers24h, price, status: () => ({ usedWeight, bannedUntil: pausedUntil }) };
}

/**
 * Live tickers for every coin on one socket, plus kline sockets opened only while someone listens.
 * Mirrors the server stream: the same ticker and candle shapes, and a price older than 15s counts as stale.
 */
export function createStream(symbols) {
  const listeners = new Set();
  const tickers = {};
  const prices = {};
  const state = { status: 'connecting', lastMessageAt: 0, lastError: null, connectedAt: 0, reconnects: 0 };
  const emit = (type, data) => { for (const l of listeners) l(type, data); };
  const setStatus = (status, err) => {
    state.status = status;
    if (err) state.lastError = err;
    emit('status', { ...state });
  };

  function open(streams, onData, { onOpen, onClose } = {}) {
    let ws, stopped = false, attempts = 0, wsIndex = spotIndex, timer;
    const connect = () => {
      if (stopped) return;
      ws = new NativeWebSocket(`${SPOT_WS[wsIndex]}/stream?streams=${streams.join('/')}`);
      ws.onopen = () => { attempts = 0; onOpen?.(); };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.data) onData(msg.data);
      };
      ws.onclose = () => {
        if (stopped) return;
        attempts++;
        if (attempts >= 2 && wsIndex < SPOT_WS.length - 1) wsIndex++; // try the mirror if the main address keeps failing
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts, 5));
        onClose?.(`Socket closed; retrying in ${Math.round(delay / 1000)}s`);
        timer = setTimeout(connect, delay);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }

  open(symbols.map((s) => `${s.toLowerCase()}@ticker`), (d) => {
    if (d.e !== '24hrTicker') return;
    state.lastMessageAt = Date.now();
    const t = {
      symbol: d.s, lastPrice: Number(d.c), priceChange: Number(d.p), priceChangePercent: Number(d.P),
      highPrice: Number(d.h), lowPrice: Number(d.l), volume: Number(d.v), quoteVolume: Number(d.q), eventTime: d.E,
    };
    tickers[d.s] = t;
    prices[d.s] = { price: t.lastPrice, eventTime: d.E, receivedAt: state.lastMessageAt };
    emit('ticker', t);
  }, {
    onOpen: () => { state.connectedAt = Date.now(); setStatus('connected'); },
    onClose: (why) => { state.reconnects++; setStatus('disconnected', why); },
  });

  const klineSockets = new Map(); // key -> { stop, count }
  function watchKlines(symbol, interval) {
    const key = `${symbol}:${interval}`;
    let entry = klineSockets.get(key);
    if (!entry) {
      const stop = open([`${symbol.toLowerCase()}@kline_${interval}`], (d) => {
        if (d.e !== 'kline') return;
        const k = d.k;
        state.lastMessageAt = Date.now();
        const candle = {
          symbol: d.s, interval: k.i, openTime: k.t, closeTime: k.T, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
          volume: Number(k.v), quoteVolume: Number(k.q), trades: k.n, takerBuyVolume: Number(k.V), closed: k.x, eventTime: d.E,
        };
        if (!prices[d.s] || d.E >= prices[d.s].eventTime) prices[d.s] = { price: candle.close, eventTime: d.E, receivedAt: state.lastMessageAt };
        emit('kline', candle);
      });
      entry = { stop, count: 0 };
      klineSockets.set(key, entry);
    }
    entry.count++;
    return () => {
      entry.count--;
      if (entry.count <= 0) { entry.stop(); klineSockets.delete(key); }
    };
  }

  function livePrice(symbol, maxAgeMs = 15000) {
    const p = prices[symbol];
    return p && Date.now() - p.receivedAt <= maxAgeMs ? p : null;
  }

  return { tickers, state, livePrice, watchKlines, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
}

// captured before the demo replaces window.WebSocket
export const NativeWebSocket = globalThis.WebSocket;
