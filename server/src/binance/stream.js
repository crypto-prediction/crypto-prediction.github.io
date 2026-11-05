// Binance combined WebSocket market streams with reconnect + staleness tracking.
// Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
import { EventEmitter } from 'node:events';
import { config, INTERVALS } from '../config.js';

export function createBinanceStream({ baseUrl = config.binanceWs, symbols = config.symbols, intervals = INTERVALS, silenceMs = 60000, WS = null, backoffBaseMs = 1000 } = {}) {
  const ev = new EventEmitter();
  const prices = {}; // symbol -> { price, eventTime, receivedAt }
  const tickers = {}; // symbol -> 24h ticker from stream
  let ws = null;
  let attempts = 0;
  let stopped = false;
  let watchdog = null;
  let reconnectTimer = null;
  const state = { status: 'connecting', lastMessageAt: 0, lastError: null, connectedAt: 0, reconnects: 0 };

  // Binance allows 1024 streams per connection; each pair uses 1 ticker + 1 per interval.
  function buildUrl(list) {
    const streams = list.flatMap((s) => {
      const l = s.toLowerCase();
      return [`${l}@ticker`, ...intervals.map((i) => `${l}@kline_${i}`)];
    });
    return `${baseUrl}/stream?streams=${streams.join('/')}`;
  }
  let url = buildUrl(symbols);

  function setStatus(status, err) {
    state.status = status;
    if (err) state.lastError = err;
    ev.emit('status', { ...state });
  }

  function connect() {
    if (stopped) return;
    setStatus(attempts ? 'reconnecting' : 'connecting');
    ws = new WS(url);
    ws.on('open', () => {
      attempts = 0;
      state.connectedAt = Date.now();
      setStatus('connected');
    });
    ws.on('message', (buf) => {
      state.lastMessageAt = Date.now();
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      const d = msg.data;
      if (!d) return;
      if (d.e === '24hrTicker') {
        const t = {
          symbol: d.s, lastPrice: Number(d.c), priceChange: Number(d.p), priceChangePercent: Number(d.P),
          highPrice: Number(d.h), lowPrice: Number(d.l), volume: Number(d.v), quoteVolume: Number(d.q), eventTime: d.E,
        };
        tickers[d.s] = t;
        prices[d.s] = { price: t.lastPrice, eventTime: d.E, receivedAt: state.lastMessageAt };
        ev.emit('ticker', t);
      } else if (d.e === 'kline') {
        const k = d.k;
        const candle = {
          symbol: d.s, interval: k.i, openTime: k.t, closeTime: k.T,
          open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
          volume: Number(k.v), quoteVolume: Number(k.q), trades: k.n, takerBuyVolume: Number(k.V), closed: k.x, eventTime: d.E,
        };
        // kline close is a fresher price than the 1s ticker
        if (!prices[d.s] || d.E >= prices[d.s].eventTime) prices[d.s] = { price: candle.close, eventTime: d.E, receivedAt: state.lastMessageAt };
        ev.emit('kline', candle);
      }
    });
    ws.on('error', (err) => { state.lastError = err.message; });
    ws.on('close', (code) => {
      clearTimeout(reconnectTimer);
      if (stopped) return setStatus('stopped');
      attempts++;
      state.reconnects++;
      const delay = Math.min(30000, backoffBaseMs * 2 ** Math.min(attempts - 1, 5));
      setStatus('disconnected', `Socket closed (${code}); retrying in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(connect, delay);
    });
  }

  async function start() {
    stopped = false;
    if (!WS) WS = (await import('ws')).default;
    connect();
    watchdog = setInterval(() => {
      if (state.status === 'connected' && Date.now() - state.lastMessageAt > silenceMs) {
        state.lastError = `No data for ${silenceMs / 1000}s; reconnecting`;
        ws?.terminate();
      }
    }, 5000);
  }

  function stop() {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(reconnectTimer);
    ws?.close();
  }

  /** Latest live price, or null if none / older than maxAgeMs. */
  function livePrice(symbol, maxAgeMs = config.staleAfterMs) {
    const p = prices[symbol];
    if (!p) return null;
    if (Date.now() - p.receivedAt > maxAgeMs) return null;
    return p;
  }

  /** Change the pairs being streamed (for example after a delisting) and reconnect. */
  function setSymbols(next) {
    for (const s of symbols) {
      if (!next.includes(s)) { delete prices[s]; delete tickers[s]; }
    }
    symbols = next;
    url = buildUrl(next);
    ws?.terminate();
  }

  return Object.assign(ev, { start, stop, livePrice, setSymbols, prices, tickers, state, get url() { return url; } });
}
