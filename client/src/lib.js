// API helpers, formatting and the live WebSocket hook.
import { useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Cannot reach the Signal Lab server. Is it running on port 4000?', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (HTTP ${res.status})`, res.status, data);
  return data;
}

export * from './format.js';

/** Live feed from the Signal Lab server (which relays Binance WebSocket streams). */
export function useLive(symbol, interval, onKline) {
  const [tickers, setTickers] = useState({});
  const [status, setStatus] = useState({ status: 'connecting' });
  const [lastMsg, setLastMsg] = useState(0);
  const wsRef = useRef(null);
  const klineRef = useRef(onKline);
  klineRef.current = onKline;
  const pending = useRef({});
  const subRef = useRef({ symbol, interval });
  subRef.current = { symbol, interval };

  useEffect(() => {
    let stopped = false, retry = 0, timer;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { retry = 0; ws.send(JSON.stringify({ type: 'subscribe', ...subRef.current })); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        setLastMsg(Date.now());
        if (m.type === 'ticker') {
          // about one message per second per coin; collected so the page redraws at most twice a second
          pending.current[m.data.symbol] = { ...m.data, receivedAt: Date.now() };
        }
        else if (m.type === 'status') setStatus(m);
        else if (m.type === 'kline') klineRef.current?.(m.data);
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus({ status: 'server-disconnected', lastError: 'Lost connection to the Signal Lab server' });
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    connect();
    const flush = setInterval(() => {
      if (!Object.keys(pending.current).length) return;
      const batch = pending.current;
      pending.current = {};
      setTickers((t) => ({ ...t, ...batch }));
    }, 500);
    return () => { stopped = true; clearTimeout(timer); clearInterval(flush); wsRef.current?.close(); };
  }, []);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws?.readyState === 1 && symbol) ws.send(JSON.stringify({ type: 'subscribe', symbol, interval }));
  }, [symbol, interval]);

  return { tickers, status, lastMsg };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
