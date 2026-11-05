// Saves timestamped forecasts and scores them against the prices that actually followed.
// Nothing here estimates accuracy: a metric exists only once real outcomes have been recorded.
import { HORIZONS, MODEL_ID } from './forecast.js';

export const MIN_SCORED = 30;
const CANDLE_MS = { '15m': 900e3, '1h': 3600e3, '4h': 14400e3 };

export function createTracker({ pool, rest, markets, forecastFor }) {
  async function record() {
    let saved = 0;
    for (const symbol of markets.active()) {
      for (const horizon of Object.keys(HORIZONS)) {
        try {
          // a model only needs fitting here once a new candle has closed
          const candleMs = CANDLE_MS[HORIZONS[horizon].interval];
          const latestClose = Math.floor(Date.now() / candleMs) * candleMs - 1;
          const { rows: have } = await pool.query(
            'SELECT 1 FROM forecasts WHERE symbol=$1 AND horizon=$2 AND model=$3 AND as_of=to_timestamp($4/1000.0)',
            [symbol, horizon, MODEL_ID, latestClose],
          );
          if (have.length) continue;
          const f = await forecastFor(symbol, horizon);
          if (f.unavailable) continue;
          const { rowCount } = await pool.query(
            `INSERT INTO forecasts (symbol, horizon, model, as_of, target_time, reference_price, probability_up, direction, range_low, range_high, regime)
             VALUES ($1,$2,$3,to_timestamp($4/1000.0),to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11)
             ON CONFLICT (symbol, horizon, model, as_of) DO NOTHING`,
            [symbol, horizon, f.model, f.asOfClose, f.targetTime, f.referenceClose, f.probabilityUp, f.direction, f.range.low, f.range.high, f.regime],
          );
          saved += rowCount;
        } catch (e) {
          console.warn(`[tracker] ${symbol} ${horizon}: ${e.message}`);
        }
        await new Promise((r) => setImmediate(r)); // let live prices through between model fits
      }
    }
    return saved;
  }

  /** Scores forecasts whose target candle has closed, using that candle's real close. */
  async function resolve(limit = 200) {
    const { rows } = await pool.query(
      `SELECT id, symbol, horizon, reference_price, range_low, range_high, extract(epoch from target_time)*1000 AS target
       FROM forecasts WHERE resolved_at IS NULL AND target_time <= now() ORDER BY target_time LIMIT $1`, [limit]);
    let resolved = 0;
    for (const f of rows) {
      const spec = HORIZONS[f.horizon];
      if (!spec) continue;
      try {
        const candleMs = CANDLE_MS[spec.interval];
        const openTime = Math.round(f.target) + 1 - candleMs;
        const [k] = await rest.request('/api/v3/klines', { symbol: f.symbol, interval: spec.interval, startTime: openTime, limit: 1 });
        if (!k || k[0] !== openTime || k[6] >= Date.now()) continue; // that candle isn't available or hasn't closed yet
        const actual = Number(k[4]);
        await pool.query(
          `UPDATE forecasts SET resolved_at=now(), actual_price=$1, outcome_up=$2, in_range=$3 WHERE id=$4`,
          [actual, actual > f.reference_price, actual >= f.range_low && actual <= f.range_high, f.id],
        );
        resolved++;
      } catch (e) {
        console.warn(`[tracker] resolving ${f.id}: ${e.message}`);
        break; // Binance trouble: try again on the next run
      }
    }
    return resolved;
  }

  async function counts() {
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS saved, COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS pending, COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS scored FROM forecasts WHERE model=$1`, [MODEL_ID]);
    return c;
  }

  async function performance() {
    const { rows } = await pool.query(
      `SELECT symbol, horizon, model, probability_up, direction, regime, outcome_up, in_range, as_of, resolved_at FROM forecasts WHERE resolved_at IS NOT NULL AND model=$1`, [MODEL_ID]);
    const { rows: [counts] } = await pool.query(
      `SELECT COUNT(*)::int AS saved, COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS pending, MIN(created_at) AS first_saved, MAX(created_at) AS last_saved FROM forecasts WHERE model=$1`, [MODEL_ID]);
    return { model: MODEL_ID, ...counts, minimumForJudgement: MIN_SCORED, ...scoreBreakdown(rows) };
  }

  async function recent(limit = 30) {
    const { rows } = await pool.query(
      `SELECT symbol, horizon, direction, probability_up, reference_price, actual_price, outcome_up, in_range, as_of, target_time, resolved_at
       FROM forecasts WHERE resolved_at IS NOT NULL AND model=$2 ORDER BY resolved_at DESC, id DESC LIMIT $1`, [Math.min(100, limit), MODEL_ID]);
    return rows;
  }

  return { record, resolve, counts, performance, recent };
}

/** Scores resolved forecasts. Rows need probability_up, direction and outcome_up. */
export function score(rows) {
  const n = rows.length;
  if (!n) return { n: 0, directionalCalls: 0, accuracy: null, precisionUp: null, recallUp: null, brier: null, baseRateUp: null, rangeCoverage: null };
  let brier = 0, ups = 0, inRange = 0, ranged = 0;
  let calls = 0, correct = 0, tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const y = r.outcome_up ? 1 : 0;
    brier += (r.probability_up - y) ** 2;
    ups += y;
    if (r.in_range !== null && r.in_range !== undefined) { ranged++; if (r.in_range) inRange++; }
    const callUp = r.direction === 'Up';
    const callDown = r.direction === 'Down';
    if (callUp || callDown) {
      calls++;
      if ((callUp && y) || (callDown && !y)) correct++;
    }
    if (callUp && y) tp++;
    if (callUp && !y) fp++;
    if (!callUp && y) fn++;
  }
  return {
    n,
    directionalCalls: calls,
    accuracy: calls ? correct / calls : null,
    precisionUp: tp + fp ? tp / (tp + fp) : null,
    recallUp: tp + fn ? tp / (tp + fn) : null,
    brier: brier / n,
    baseRateUp: ups / n,
    rangeCoverage: ranged ? inRange / ranged : null,
  };
}

/** How often "up" really happened in each predicted-probability band. */
export function calibration(rows, bins = 5) {
  const out = Array.from({ length: bins }, (_, i) => ({ from: i / bins, to: (i + 1) / bins, n: 0, sumP: 0, ups: 0 }));
  for (const r of rows) {
    const b = out[Math.min(bins - 1, Math.floor(r.probability_up * bins))];
    b.n++;
    b.sumP += r.probability_up;
    if (r.outcome_up) b.ups++;
  }
  return out.map(({ from, to, n, sumP, ups }) => ({ from, to, n, meanPredicted: n ? sumP / n : null, observedUp: n ? ups / n : null }));
}

const groupBy = (rows, key) => {
  const groups = {};
  for (const r of rows) (groups[r[key]] ||= []).push(r);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, score(v)]));
};

export function scoreBreakdown(rows) {
  const regimeName = { Uptrend: 'Bullish', Downtrend: 'Bearish', Mixed: 'Sideways' };
  const withRegime = rows.map((r) => ({ ...r, market: regimeName[r.regime] || 'Unknown' }));
  return {
    overall: score(rows),
    calibration: calibration(rows),
    byCoin: groupBy(rows, 'symbol'),
    byHorizon: groupBy(rows, 'horizon'),
    byMarket: groupBy(withRegime, 'market'),
  };
}
