// Installed before the app starts in the online demo build only. The dashboard and Lab code stay exactly as they
// are: their /api requests and /ws socket are answered here, in the browser, instead of by the Signal Lab server.
import { createDemoServer } from './server.js';
import { NativeWebSocket } from './binance.js';

const BASE = import.meta.env.BASE_URL; // for example /crypto-prediction/
const REPO = 'https://github.com/muzammil11123/crypto-prediction';
const demo = createDemoServer();
const apiPath = (pathname) => {
  const m = pathname.match(/^(?:\/[^/]+)?\/api(\/.*)$/);
  return m && (pathname.startsWith('/api/') || pathname.startsWith(`${BASE}api/`)) ? m[1] : null;
};

// ---- /api requests
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const path = url.origin === location.origin ? apiPath(url.pathname) : null;
  if (!path) return nativeFetch(input, init);
  const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
  let body = {};
  if (init.body) { try { body = JSON.parse(init.body); } catch { body = {}; } }
  const r = await demo.handle(method, path, url.searchParams, body);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

// ---- the /ws socket: the same messages the server relays
class DemoSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    this.readyState = 0;
    this.sub = { symbol: 'BTCUSDT', interval: '1h' };
    this.lastTicker = {};
    this.listeners = {};
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.fire('open', {});
      this.push({ type: 'status', ...demo.stream.state });
      for (const t of Object.values(demo.stream.tickers)) this.push({ type: 'ticker', data: t });
      this.watch();
      this.stop = demo.stream.subscribe((type, data) => {
        if (type === 'status') this.push({ type: 'status', ...data });
        else if (type === 'ticker') {
          if (Date.now() - (this.lastTicker[data.symbol] || 0) < 1000) return;
          this.lastTicker[data.symbol] = Date.now();
          this.push({ type: 'ticker', data });
        } else if (type === 'kline' && data.symbol === this.sub.symbol && data.interval === this.sub.interval) this.push({ type: 'kline', data });
      });
    }, 0);
  }

  watch() {
    this.unwatch?.();
    this.unwatch = demo.stream.watchKlines(this.sub.symbol, this.sub.interval);
  }

  send(raw) {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'subscribe' && m.symbol && m.interval) {
        this.sub = { symbol: m.symbol, interval: m.interval };
        this.watch();
      }
    } catch { /* ignored, as on the server */ }
  }

  push(msg) {
    if (this.readyState === 1) this.fire('message', { data: JSON.stringify(msg) });
  }

  fire(type, ev) {
    this[`on${type}`]?.(ev);
    for (const fn of this.listeners[type] || []) fn(ev);
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }

  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.stop?.();
    this.unwatch?.();
    setTimeout(() => this.fire('close', { code: 1000 }), 0);
  }
}

globalThis.WebSocket = function WebSocket(url, protocols) {
  const u = new URL(url, location.href);
  if (u.host === location.host && /\/ws$/.test(u.pathname)) return new DemoSocket();
  return new NativeWebSocket(url, protocols);
};
Object.assign(globalThis.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

// ---- links: the app links to /lab.html and /, which live under the demo's base path on GitHub Pages
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  const href = a?.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith(BASE) || a.target === '_blank') return;
  e.preventDefault();
  location.href = `${BASE}${href.slice(1)}`;
}, true);

// ---- a tab icon, so browsers don't ask the host for a /favicon.ico that doesn't exist
const icon = Object.assign(document.createElement('link'), { rel: 'icon', type: 'image/svg+xml' });
icon.href = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#070a11"/><circle cx="16" cy="16" r="7" fill="none" stroke="#22e1ff" stroke-width="3"/></svg>')}`;
document.head.append(icon);

// ---- a banner above the app, outside its layout, saying what the demo is
const banner = document.createElement('div');
banner.setAttribute('data-demo-banner', '');
banner.setAttribute('role', 'note');
banner.style.cssText = 'font:12px/1.5 Inter,system-ui,sans-serif;color:#94a3b8;background:#070a11;border-bottom:1px solid #1e2533;padding:6px 16px;text-align:center';
banner.append(
  'Online demo: live data comes straight from Binance into your browser, and paper trades are saved only in this browser. Some Lab tabs need the full app. ',
  Object.assign(document.createElement('a'), { href: REPO, target: '_blank', rel: 'noopener', textContent: 'Get the full app on GitHub', style: 'color:#22e1ff;text-decoration:underline' }),
);
document.body.prepend(banner);
