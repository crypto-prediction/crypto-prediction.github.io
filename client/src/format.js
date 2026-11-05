// Display formatting with no React dependency, so it can be unit tested on its own.

/** Decimals that keep a price meaningful, from BTC at 80,000 down to DOGE at 0.15. */
export const pricePrecision = (p) => {
  const v = Math.abs(p);
  if (v >= 10) return 2;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 8;
};

export const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const price = (v) => (v === null || v === undefined ? '—' : fmt(v, pricePrecision(v)));
/** Small values such as a DOGE MACD reading, where fixed decimals would round to 0.00. */
export const fmtSig = (v, digits = 3) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return Math.abs(v) >= 1000 ? fmt(v, 1) : Number(v.toPrecision(digits)).toString();
};
export const usd = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '-' : ''}$${fmt(Math.abs(v), d)}`);
export const pct = (v, d = 2, sign = true) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(d)}%`);
export const compact = (v) => (v === null || v === undefined ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v));
export const tone = (v) => (v > 0 ? 'text-lime-neon' : v < 0 ? 'text-rose-neon' : 'text-mute');
export const time = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short' }) : '—');
export const ago = (ms, now = Date.now()) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
