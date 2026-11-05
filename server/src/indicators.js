// Technical indicators. Every function returns an array aligned with its input;
// entries are null until enough data exists. Value at index i uses only data[0..i]
// (no look-ahead), which the backtester relies on.

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values (standard convention). Skips leading nulls. */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let start = values.findIndex((v) => v !== null && v !== undefined);
  if (start < 0 || values.length - start < n) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += values[i];
  let prev = seed / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. First value at index n. */
export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const calc = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = calc();
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = calc();
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
  const sig = ema(line, signal);
  const hist = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]));
  return { macd: line, signal: sig, histogram: hist };
}

/** Bollinger Bands: SMA(n) ± k × population standard deviation. */
export function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const width = new Array(values.length).fill(null);
  const percentB = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : null;
    percentB[i] = upper[i] === lower[i] ? 0.5 : (values[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { middle: mid, upper, lower, width, percentB };
}

/** Volume analysis: 20-bar average, relative volume, on-balance volume, taker-buy share. */
export function volumeAnalysis(candles, n = 20) {
  const vol = candles.map((c) => c.volume);
  const avg = sma(vol, n);
  const rel = vol.map((v, i) => (avg[i] ? v / avg[i] : null));
  const obv = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    obv[i] = obv[i - 1] + (d > 0 ? vol[i] : d < 0 ? -vol[i] : 0);
  }
  const buyShare = candles.map((c) => (c.volume > 0 && c.takerBuyVolume !== undefined ? c.takerBuyVolume / c.volume : null));
  return { average: avg, relative: rel, obv, buyShare };
}

/** Price momentum: % change over the last n bars (rate of change). */
export function momentum(values, n = 10) {
  return values.map((v, i) => (i >= n && values[i - n] ? (v / values[i - n] - 1) * 100 : null));
}

/** Volatility: population standard deviation of bar-to-bar % returns over the last n bars. */
export function volatility(values, n = 20) {
  const out = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i++) {
    let sum = 0;
    const rets = [];
    for (let j = i - n + 1; j <= i; j++) {
      const r = (values[j] / values[j - 1] - 1) * 100;
      rets.push(r);
      sum += r;
    }
    const mean = sum / n;
    out[i] = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / n);
  }
  return out;
}

export function computeAll(candles) {
  const close = candles.map((c) => c.close);
  return {
    ema20: ema(close, 20),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    macd: macd(close, 12, 26, 9),
    bb: bollinger(close, 20, 2),
    volume: volumeAnalysis(candles, 20),
    momentum: momentum(close, 10),
    volatility: volatility(close, 20),
  };
}
