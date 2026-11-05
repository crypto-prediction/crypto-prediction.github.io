// Statistical forecasting engine: L2 logistic regression on technical features, with a chronological
// holdout to measure whether it has any edge. It is a statistics model, not an AI model, and reports
// itself as such. Every feature at bar i reads candles up to i only, and a training label is used only
// when its outcome bar has already closed.
import { computeAll } from '../indicators.js';
import { marketTrend } from '../analysis.js';

export const MODEL_ID = 'logistic-technical-v2';

// Which candles each horizon is modelled on, how many make up the horizon, and how much history it
// trains on. Longer horizons need far more history, because their outcomes overlap heavily.
export const HORIZONS = {
  '15m': { interval: '15m', bars: 1, ms: 900e3, history: 1000 },
  '1h': { interval: '1h', bars: 1, ms: 3600e3, history: 1000 },
  '4h': { interval: '1h', bars: 4, ms: 4 * 3600e3, history: 2000 },
  '24h': { interval: '1h', bars: 24, ms: 24 * 3600e3, history: 5000 },
  '7d': { interval: '4h', bars: 42, ms: 7 * 86400e3, history: 5000 },
};

const WARMUP = 210;
const MIN_ROWS = 150;
const EDGE_UP = 0.55;
const EDGE_DOWN = 0.45;
export const MIN_INDEPENDENT = 20; // non-overlapping test periods needed before claiming any edge

const FEATURES = [
  { key: 'ema20', label: 'Price vs EMA 20', fmt: (v) => `${v.toFixed(2)}%` },
  { key: 'ema2050', label: 'EMA 20 vs EMA 50', fmt: (v) => `${v.toFixed(2)}%` },
  { key: 'ema200', label: 'Price vs EMA 200', fmt: (v) => `${v.toFixed(2)}%` },
  { key: 'rsi', label: 'RSI 14', fmt: (v) => (v + 50).toFixed(1) },
  { key: 'macd', label: 'MACD histogram', fmt: (v) => `${v.toFixed(3)}% of price` },
  { key: 'pctB', label: 'Bollinger %B', fmt: (v) => v.toFixed(2) },
  { key: 'momentum', label: '10-bar momentum', fmt: (v) => `${v.toFixed(2)}%` },
  { key: 'volume', label: 'Relative volume', fmt: (v) => `${Math.exp(v).toFixed(2)}×` },
];

function featureRow(candles, ind, i) {
  const c = candles[i].close;
  const vals = [ind.ema20[i], ind.ema50[i], ind.ema200[i], ind.rsi14[i], ind.macd.histogram[i], ind.bb.percentB[i], ind.momentum[i], ind.volume.relative[i]];
  if (vals.some((v) => v === null || v === undefined || !Number.isFinite(v))) return null;
  return [
    (c / ind.ema20[i] - 1) * 100,
    (ind.ema20[i] / ind.ema50[i] - 1) * 100,
    (c / ind.ema200[i] - 1) * 100,
    ind.rsi14[i] - 50,
    (ind.macd.histogram[i] / c) * 100,
    ind.bb.percentB[i],
    ind.momentum[i],
    Math.log(Math.max(ind.volume.relative[i], 0.01)),
  ];
}

/** L2-regularised logistic regression by gradient descent. Features are standardised on the training rows only. */
export function fitLogistic(X, y, { iterations = 300, rate = 0.3, l2 = 0.02 } = {}) {
  const d = X[0].length;
  const n = X.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * Z[i][j];
      const err = 1 / (1 + Math.exp(-s)) - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
    }
    b -= (rate * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= rate * (gw[j] / n + l2 * w[j]);
  }
  const standardize = (row) => row.map((v, j) => (v - mean[j]) / std[j]);
  const predict = (row) => {
    let s = b;
    standardize(row).forEach((v, j) => { s += w[j] * v; });
    return 1 / (1 + Math.exp(-s));
  };
  return { predict, weights: w, bias: b, standardize };
}

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
};

/** Nearest swing levels around a price: pivots with `span` bars either side, using closed candles. */
export function supportResistance(candles, price, { lookback = 200, span = 5 } = {}) {
  const recent = candles.slice(-lookback);
  const lows = [];
  const highs = [];
  for (let i = span; i < recent.length - span; i++) {
    const win = recent.slice(i - span, i + span + 1);
    if (recent[i].low === Math.min(...win.map((c) => c.low))) lows.push(recent[i].low);
    if (recent[i].high === Math.max(...win.map((c) => c.high))) highs.push(recent[i].high);
  }
  const below = lows.filter((v) => v < price).sort((a, b) => b - a);
  const above = highs.filter((v) => v > price).sort((a, b) => a - b);
  return {
    support: below[0] ?? null,
    resistance: above[0] ?? null,
    method: `Nearest swing low and high in the last ${recent.length} candles`,
  };
}

/**
 * Chronological three-way split: train the model, then learn how far to trust it on later data, then
 * measure the result on later data still. Each stage only sees the future of the one before, with a gap
 * so that no outcome overlaps between stages.
 * `shrink` scales the model's lean toward the base rate: 0 means its lean carried no information.
 */
function holdoutSkill(rows, horizonBars) {
  const a = Math.floor(rows.length * 0.6);
  const b = Math.floor(rows.length * 0.8);
  const train = rows.slice(0, a);
  const tune = rows.slice(a + horizonBars, b);
  const test = rows.slice(b + horizonBars);
  if (train.length < MIN_ROWS / 2 || tune.length < 30 || test.length < 30) return null;
  const model = fitLogistic(train.map((r) => r.x), train.map((r) => r.y));
  const base = train.reduce((s, r) => s + r.y, 0) / train.length;
  const tuned = tune.map((r) => ({ p: model.predict(r.x), y: r.y }));
  let shrink = 0;
  let bestLoss = Infinity;
  for (let k = 0; k <= 10; k++) {
    const s = k / 10;
    const loss = tuned.reduce((sum, r) => sum + (base + s * (r.p - base) - r.y) ** 2, 0);
    if (loss < bestLoss - 1e-12) { bestLoss = loss; shrink = s; }
  }
  let hits = 0, brier = 0, baseBrier = 0;
  for (const r of test) {
    const p = base + shrink * (model.predict(r.x) - base);
    if ((p >= 0.5 ? 1 : 0) === r.y) hits++;
    brier += (p - r.y) ** 2;
    baseBrier += (base - r.y) ** 2;
  }
  const n = test.length;
  return {
    samples: n,
    independentSamples: Math.floor(n / Math.max(1, horizonBars)),
    accuracy: hits / n,
    brier: brier / n,
    baselineBrier: baseBrier / n,
    brierSkill: baseBrier > 0 ? 1 - brier / baseBrier : 0,
    shrink,
  };
}

/**
 * Forecast for one coin and horizon from closed candles.
 * Returns { unavailable: reason } when there isn't enough history; it never guesses.
 */
export function forecast(candlesAll, horizon, { livePrice = null } = {}) {
  const spec = HORIZONS[horizon];
  if (!spec) throw Object.assign(new Error(`Unknown horizon ${horizon}`), { status: 400 });
  const candles = candlesAll.filter((c) => c.closed !== false);
  const h = spec.bars;
  if (candles.length < WARMUP + MIN_ROWS + h) {
    return { unavailable: `Needs ${WARMUP + MIN_ROWS + h} closed ${spec.interval} candles, has ${candles.length}` };
  }
  const ind = computeAll(candles);
  const last = candles.length - 1;
  const rows = [];
  for (let i = WARMUP; i + h <= last; i++) {
    const x = featureRow(candles, ind, i);
    if (x) rows.push({ i, x, y: candles[i + h].close > candles[i].close ? 1 : 0 });
  }
  const nowX = featureRow(candles, ind, last);
  if (rows.length < MIN_ROWS || !nowX) return { unavailable: 'Not enough complete indicator history' };

  const model = fitLogistic(rows.map((r) => r.x), rows.map((r) => r.y));
  const skill = holdoutSkill(rows, h);
  // the raw lean is scaled by how much it could be trusted on later data; with no evidence, none of it is kept
  const baseRate = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const pUp = Math.max(0.02, Math.min(0.98, baseRate + (skill ? skill.shrink : 0) * (model.predict(nowX) - baseRate)));
  const close = candles[last].close;
  const price = livePrice ?? close;
  const direction = pUp >= EDGE_UP ? 'Up' : pUp <= EDGE_DOWN ? 'Down' : 'Sideways';

  // range: this coin's own past h-bar returns, scaled by how volatile it is now compared with usual
  const moves = [];
  for (let i = 0; i + h <= last; i++) moves.push(candles[i + h].close / candles[i].close - 1);
  const sorted = [...moves].sort((a, b) => a - b);
  const vols = ind.volatility.filter((v) => v !== null);
  const sortedVols = [...vols].sort((a, b) => a - b);
  const volNow = ind.volatility[last];
  const volRatio = Math.max(0.5, Math.min(2, volNow / (quantile(sortedVols, 0.5) || volNow || 1)));
  const moveMean = moves.reduce((a, b) => a + b, 0) / moves.length;
  const moveStd = Math.sqrt(moves.reduce((a, b) => a + (b - moveMean) ** 2, 0) / moves.length);
  const expectedVolPct = moveStd * volRatio * 100;
  const volPercentile = sortedVols.filter((v) => v <= volNow).length / sortedVols.length;
  const riskLevel = volPercentile >= 0.8 ? 'High' : volPercentile >= 0.4 ? 'Medium' : 'Low';

  // confidence requires a measured edge on the holdout; a strong probability alone isn't enough
  const lean = Math.abs(pUp - 0.5);
  const hasEdge = Boolean(skill && skill.brierSkill > 0 && skill.independentSamples >= MIN_INDEPENDENT);
  const confidence = !hasEdge || lean < 0.05 ? 'Low' : skill.brierSkill > 0.02 && lean >= 0.1 ? 'High' : 'Medium';

  const z = model.standardize(nowX);
  const reasons = FEATURES.map((f, j) => ({ label: f.label, reading: f.fmt(nowX[j]), effect: model.weights[j] * z[j] }))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, 4)
    .map((r) => ({ ...r, pushes: r.effect >= 0 ? 'up' : 'down' }));

  return {
    horizon,
    interval: spec.interval,
    bars: h,
    model: MODEL_ID,
    modelType: 'statistical',
    asOfClose: candles[last].closeTime,
    targetTime: candles[last].closeTime + spec.ms,
    price,
    referenceClose: close,
    direction,
    probabilityUp: pUp,
    probabilityDown: 1 - pUp,
    baseRateUp: baseRate,
    confidence,
    hasMeasuredEdge: hasEdge,
    range: { low: price * (1 + quantile(sorted, 0.1) * volRatio), high: price * (1 + quantile(sorted, 0.9) * volRatio), coverage: 80 },
    ...supportResistance(candles, price),
    expectedVolatilityPct: expectedVolPct,
    riskLevel,
    regime: marketTrend(close, ind.ema50[last], ind.ema200[last]),
    reasons,
    holdout: skill,
    trainingRows: rows.length,
  };
}
