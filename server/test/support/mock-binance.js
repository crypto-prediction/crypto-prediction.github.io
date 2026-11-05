// TEST-ONLY fake Binance (REST + WebSocket) speaking the documented response formats.
// Prices are deterministic formula fixtures for integration tests; never used by the app itself.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const BASE = { BTCUSDT: 60000, ETHUSDT: 3000, SOLUSDT: 150, BNBUSDT: 600, XRPUSDT: 0.6, DOGEUSDT: 0.15, ADAUSDT: 0.45, LINKUSDT: 15, AVAXUSDT: 30, LTCUSDT: 80 };
// each coin gets its own wave phase so per-coin calculations can be told apart
const PHASE = Object.fromEntries(Object.keys(BASE).map((s, i) => [s, i]));
const px = (s, t, ms) => { const i = t / ms + PHASE[s] * 7; return BASE[s] * (1 + 0.06 * Math.sin(i / 23) + 0.025 * Math.sin(i / 6.1) + 0.01 * Math.cos(i / 2.3)); };
const dp = (s) => (BASE[s] < 10 ? 6 : 2);

function kline(s, iv, open, now) {
  const ms = MS[iv];
  const o = px(s, open - ms, ms), c = open + ms > now ? px(s, now, ms) : px(s, open, ms);
  const h = Math.max(o, c) * 1.003, l = Math.min(o, c) * 0.997, v = 100 + 50 * Math.abs(Math.sin(open / ms / 5));
  return [open, o.toFixed(dp(s)), h.toFixed(dp(s)), l.toFixed(dp(s)), c.toFixed(dp(s)), v.toFixed(4), open + ms - 1, (v * c).toFixed(2), 1000, (v * 0.52).toFixed(4), '0', '0'];
}

export function startMockBinance({ port = 0, fail = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(u.pathname + u.search);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'x-mbx-used-weight-1m': '7', ...headers }); res.end(JSON.stringify(body)); };
    if (fail.status) return send(fail.status, { code: -1, msg: 'mock failure' }, fail.headers);
    const now = Date.now();
    if (u.pathname === '/api/v3/klines') {
      const s = u.searchParams.get('symbol'), iv = u.searchParams.get('interval'), ms = MS[iv];
      const limit = Number(u.searchParams.get('limit') || 500);
      if (u.searchParams.get('startTime')) {
        const st = Number(u.searchParams.get('startTime'));
        const first = Math.ceil(st / ms) * ms;
        const stop = u.searchParams.get('endTime') ? Number(u.searchParams.get('endTime')) : now;
        const rows = [];
        for (let open = first; open <= Math.min(now, stop) && rows.length < limit; open += ms) rows.push(kline(s, iv, open, now));
        return send(200, rows);
      }
      const end = u.searchParams.get('endTime') ? Number(u.searchParams.get('endTime')) : now;
      const lastOpen = Math.floor(end / ms) * ms;
      const rows = [];
      for (let i = limit - 1; i >= 0; i--) rows.push(kline(s, iv, lastOpen - i * ms, now));
      return send(200, rows);
    }
    if (u.pathname === '/api/v3/ticker/24hr') {
      const syms = JSON.parse(u.searchParams.get('symbols'));
      return send(200, syms.map((s) => {
        const p = px(s, now, 60e3), o = px(s, now - 86400e3, 60e3);
        return { symbol: s, lastPrice: p.toFixed(dp(s)), priceChange: (p - o).toFixed(2), priceChangePercent: ((p / o - 1) * 100).toFixed(3), highPrice: (p * 1.02).toFixed(2), lowPrice: (p * 0.98).toFixed(2), volume: '1234.5', quoteVolume: (1234.5 * p).toFixed(2), closeTime: now };
      }));
    }
    if (u.pathname === '/api/v3/depth') {
      const s = u.searchParams.get('symbol'), p = px(s, now, 60e3);
      const side = (sign) => Array.from({ length: 20 }, (_, i) => [(p * (1 + sign * (i + 1) * 0.0004)).toFixed(dp(s)), String(10 + i)]);
      return send(200, { lastUpdateId: 1, bids: side(-1), asks: side(1) });
    }
    if (u.pathname === '/api/v3/exchangeInfo') {
      const listed = Object.keys(BASE).filter((s) => !(fail.delisted || []).includes(s));
      return send(200, { symbols: listed.map((s) => ({ symbol: s, status: 'TRADING', isSpotTradingAllowed: true })) });
    }
    if (u.pathname === '/api/v3/ticker/price') {
      const s = u.searchParams.get('symbol');
      return send(200, { symbol: s, price: px(s, now, 60e3).toFixed(dp(s)) });
    }
    send(404, { code: -1, msg: 'unknown' });
  });
  const wss = new WebSocketServer({ server, path: '/stream' });
  const timers = [];
  wss.on('connection', (ws, req) => {
    const streams = new URL(req.url, 'http://x').searchParams.get('streams').split('/');
    const t = setInterval(() => {
      const now = Date.now();
      for (const st of streams) {
        const [sl, kind] = st.split('@');
        const s = sl.toUpperCase();
        if (kind === 'ticker') {
          const p = px(s, now, 60e3).toFixed(dp(s));
          ws.send(JSON.stringify({ stream: st, data: { e: '24hrTicker', E: now, s, c: p, p: '1', P: '0.5', h: p, l: p, v: '1000', q: '5000000' } }));
        } else {
          const iv = kind.replace('kline_', ''), ms = MS[iv], open = Math.floor(now / ms) * ms;
          const k = kline(s, iv, open, now);
          ws.send(JSON.stringify({ stream: st, data: { e: 'kline', E: now, s, k: { t: k[0], T: k[6], s, i: iv, o: k[1], c: k[4], h: k[2], l: k[3], v: k[5], n: 10, x: false, q: k[7], V: k[9] } } }));
        }
      }
    }, 300);
    timers.push(t);
    ws.on('close', () => clearInterval(t));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const { port: p } = server.address();
    resolve({ rest: `http://127.0.0.1:${p}`, ws: `ws://127.0.0.1:${p}`, calls, close: () => { timers.forEach(clearInterval); wss.close(); server.close(); } });
  }));
}
