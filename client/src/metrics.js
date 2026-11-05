// Calculations behind the charts and the globe. No React or browser APIs, so these are unit tested directly.

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Each value's rank within its series, 0 to 1, so one wild candle doesn't flatten all the others. */
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  order.forEach(([, i], pos) => { out[i] = values.length > 1 ? pos / (values.length - 1) : 0.5; });
  return out;
}

/** Bar-to-bar returns from closes. */
export function returns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

/** Pearson correlation of two equal-length series, or null if it can't be measured. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/**
 * The most correlated pairs of coins, for the globe's connecting lines.
 * series: [{ symbol, candles }]. Returns [{ a, b, value }] with a and b as indexes into series.
 */
export function strongestLinks(series, count = 12, window = 200) {
  const rets = series.map((s) => returns(s.candles.filter((c) => c.closed !== false).slice(-window).map((c) => c.close)));
  const links = [];
  for (let a = 0; a < series.length; a++) {
    for (let b = a + 1; b < series.length; b++) {
      const value = correlation(rets[a], rets[b]);
      if (value !== null) links.push({ a, b, value });
    }
  }
  return links.sort((x, y) => y.value - x.value).slice(0, count);
}

/** Keep the largest parts and fold the rest into one "Other" slice, so a pie stays readable. */
export function topSlices(slices, keep = 5, otherColor = '#5B6472') {
  const sorted = [...slices].sort((a, b) => b.value - a.value);
  if (sorted.length <= keep + 1) return sorted;
  const rest = sorted.slice(keep);
  const value = rest.reduce((sum, s) => sum + s.value, 0);
  return [...sorted.slice(0, keep), { label: `Other (${rest.length})`, value, color: otherColor, members: rest.map((s) => s.label) }];
}

/** Market activity from 0 to 1: the latest candle's volume vs its 20-candle average. No reading means no activity shown. */
export function activityLevel(relativeVolume) {
  if (relativeVolume === null || relativeVolume === undefined || !Number.isFinite(relativeVolume)) return 0;
  return Math.max(0, Math.min(1, relativeVolume / 2));
}
