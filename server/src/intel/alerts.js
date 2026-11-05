// Alert rules are evaluated on the server, so they keep running while the dashboard is closed, for as
// long as the server runs. A rule fires when its condition becomes true, not on every check, and
// (rule, candle) is unique in the database, so the same condition can't notify twice.
import { EventEmitter } from 'node:events';
import { computeAll } from '../indicators.js';
import { marketSnapshot } from '../analysis.js';
import { coinInfo } from '../coins.js';
import { INTERVALS } from '../config.js';

const num = (p, k, d) => (Number.isFinite(Number(p?.[k])) && p?.[k] !== '' && p?.[k] !== null && p?.[k] !== undefined ? Number(p[k]) : d);

export const CUSTOM_METRICS = {
  price: 'Price',
  rsi: 'RSI 14',
  relativeVolume: 'Relative volume',
  volatilityPct: 'Volatility %',
  momentumPct: 'Momentum %',
  changePct: '24h change %',
};

export const ALERT_TYPES = {
  price_above: { label: 'Price rises above', needs: ['value'] },
  price_below: { label: 'Price falls below', needs: ['value'] },
  rsi_overbought: { label: 'RSI overbought', defaults: { value: 70 } },
  rsi_oversold: { label: 'RSI oversold', defaults: { value: 30 } },
  macd_cross: { label: 'MACD crossover', defaults: {} },
  unusual_volume: { label: 'Unusual volume', defaults: { value: 2 } },
  breakout: { label: 'Breakout above 20-candle high', defaults: {} },
  support_breakdown: { label: 'Breakdown below 20-candle low', defaults: {} },
  high_volatility: { label: 'High volatility', defaults: { value: 2 } },
  forecast_change: { label: 'Forecast direction changes', defaults: { horizon: '24h' } },
  custom: { label: 'Custom condition', needs: ['metric', 'op', 'value'] },
};

/** Whether a rule's condition holds right now. snap holds real readings; returns null if they're missing. */
export function checkRule(rule, snap) {
  const p = rule.params || {};
  const name = coinInfo(rule.symbol).base;
  const v = (x, d = 2) => (Number.isFinite(x) ? Number(x.toPrecision(6)).toString() : 'n/a');
  switch (rule.type) {
    case 'price_above':
      return snap.price == null ? null : { hit: snap.price > p.value, key: 'level', message: `${name} is above ${p.value} (now ${v(snap.price)}).` };
    case 'price_below':
      return snap.price == null ? null : { hit: snap.price < p.value, key: 'level', message: `${name} is below ${p.value} (now ${v(snap.price)}).` };
    case 'rsi_overbought': {
      const t = num(p, 'value', 70);
      return snap.rsi == null ? null : { hit: snap.rsi >= t, key: 'candle', message: `${name} RSI is ${snap.rsi.toFixed(1)}, at or above ${t}.` };
    }
    case 'rsi_oversold': {
      const t = num(p, 'value', 30);
      return snap.rsi == null ? null : { hit: snap.rsi <= t, key: 'candle', message: `${name} RSI is ${snap.rsi.toFixed(1)}, at or below ${t}.` };
    }
    case 'macd_cross': {
      if (snap.macdHistogram == null || snap.macdHistogramPrev == null) return null;
      const up = snap.macdHistogramPrev <= 0 && snap.macdHistogram > 0;
      const down = snap.macdHistogramPrev >= 0 && snap.macdHistogram < 0;
      return { hit: up || down, key: 'candle', message: `${name} MACD crossed ${up ? 'above' : 'below'} its signal line.` };
    }
    case 'unusual_volume': {
      const t = num(p, 'value', 2);
      return snap.relativeVolume == null ? null : { hit: snap.relativeVolume >= t, key: 'candle', message: `${name} volume is ${snap.relativeVolume.toFixed(2)}× its 20-candle average.` };
    }
    case 'breakout':
      return snap.high20 == null ? null : { hit: snap.close > snap.high20, key: 'candle', message: `${name} closed at ${v(snap.close)}, above the prior 20-candle high of ${v(snap.high20)}.` };
    case 'support_breakdown':
      return snap.low20 == null ? null : { hit: snap.close < snap.low20, key: 'candle', message: `${name} closed at ${v(snap.close)}, below the prior 20-candle low of ${v(snap.low20)}.` };
    case 'high_volatility': {
      const t = num(p, 'value', 2);
      return snap.volatilityPct == null ? null : { hit: snap.volatilityPct >= t, key: 'candle', message: `${name} volatility is ${snap.volatilityPct.toFixed(2)}%, at or above ${t}%.` };
    }
    case 'custom': {
      const x = snap[p.metric];
      if (x == null || !Number.isFinite(x)) return null;
      const hit = p.op === '>' ? x > p.value : p.op === '<' ? x < p.value : p.op === '>=' ? x >= p.value : x <= p.value;
      return { hit, key: 'level', message: `${name} ${CUSTOM_METRICS[p.metric]} is ${v(x)} (rule: ${p.op} ${p.value}).` };
    }
    default:
      return null;
  }
}

export function validateRule(body, isKnownSymbol) {
  const { symbol, type, interval = '1h', params = {}, note = null } = body || {};
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!isKnownSymbol(symbol)) throw bad(`Unsupported symbol ${symbol}`);
  const def = ALERT_TYPES[type];
  if (!def) throw bad(`Unknown alert type ${type}`);
  if (!INTERVALS.includes(interval)) throw bad(`Unsupported interval ${interval}`);
  const out = { ...(def.defaults || {}) };
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined) out[k] = v;
  if (out.value !== undefined) {
    out.value = Number(out.value);
    if (!Number.isFinite(out.value)) throw bad('Enter a number for the value');
  }
  for (const k of def.needs || []) if (out[k] === undefined) throw bad(`This alert needs a ${k}`);
  if (type === 'custom') {
    if (!CUSTOM_METRICS[out.metric]) throw bad(`Unknown metric ${out.metric}`);
    if (!['>', '<', '>=', '<='].includes(out.op)) throw bad('The comparison must be >, <, >= or <=');
  }
  const cooldown = Number(body.cooldownMin ?? 60);
  if (!(cooldown >= 1 && cooldown <= 10080)) throw bad('Cooldown must be between 1 minute and 7 days');
  return { symbol, type, interval, params: out, note: note ? String(note).slice(0, 200) : null, cooldown };
}

export function createAlerts({ pool, markets, historyFor, tickersNow, forecastFor }) {
  const events = new EventEmitter();

  async function snapshotFor(symbol, interval, tickers) {
    const candles = (await historyFor(symbol, interval)).filter((c) => c.closed !== false);
    if (candles.length < 30) return null;
    const ind = computeAll(candles);
    const i = candles.length - 1;
    const snap = marketSnapshot(candles, ind, i);
    const prior = candles.slice(i - 20, i);
    const t = tickers[symbol];
    return {
      ...snap,
      macdHistogramPrev: ind.macd.histogram[i - 1],
      high20: Math.max(...prior.map((c) => c.high)),
      low20: Math.min(...prior.map((c) => c.low)),
      price: t?.lastPrice ?? null,
      changePct: t?.priceChangePercent ?? null,
    };
  }

  async function fire(rule, message, dedupeKey) {
    const { rows } = await pool.query(
      `INSERT INTO alert_events (rule_id, symbol, type, message, dedupe_key) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (rule_id, dedupe_key) DO NOTHING RETURNING *`, [rule.id, rule.symbol, rule.type, message, dedupeKey]);
    if (rows[0]) events.emit('alert', rows[0]);
    return Boolean(rows[0]);
  }

  /** Checks every enabled rule once. Does no market work at all when there are no rules. */
  async function evaluate(now = Date.now()) {
    const { rows: rules } = await pool.query('SELECT * FROM alert_rules WHERE enabled ORDER BY id');
    if (!rules.length) return { checked: 0, fired: 0 };
    const { tickers: list } = await tickersNow();
    const tickers = Object.fromEntries(list.map((t) => [t.symbol, t]));
    let fired = 0;
    for (const rule of rules) {
      if (!markets.isActive(rule.symbol)) continue;
      try {
        const state = rule.state || {};
        let result;
        if (rule.type === 'forecast_change') {
          const f = await forecastFor(rule.symbol, rule.params.horizon || '24h');
          if (f.unavailable) continue;
          const changed = state.direction && state.direction !== f.direction;
          result = { hit: Boolean(changed), key: `fc:${f.asOfClose}`, message: `${coinInfo(rule.symbol).base} ${f.horizon} forecast changed from ${state.direction} to ${f.direction}.`, nextState: { direction: f.direction } };
        } else {
          const snap = await snapshotFor(rule.symbol, rule.interval, tickers);
          if (!snap) continue;
          result = checkRule(rule, snap);
          if (!result) continue;
          result.key = result.key === 'candle' ? `c:${snap.asOfCandleClose}` : `t:${Math.floor(now / (rule.cooldown_min * 60e3))}`;
        }
        const wasHit = Boolean(state.hit);
        const cooled = !state.firedAt || now - state.firedAt >= rule.cooldown_min * 60e3;
        const rising = rule.type === 'forecast_change' ? result.hit : result.hit && !wasHit;
        let firedAt = state.firedAt || null;
        if (rising && cooled && await fire(rule, result.message, result.key)) { fired++; firedAt = now; }
        const next = { ...state, ...(result.nextState || {}), hit: result.hit, firedAt, checkedAt: now };
        await pool.query('UPDATE alert_rules SET state=$1 WHERE id=$2', [next, rule.id]);
      } catch (e) {
        console.warn(`[alerts] rule ${rule.id}: ${e.message}`);
      }
    }
    return { checked: rules.length, fired };
  }

  return { events, evaluate };
}
