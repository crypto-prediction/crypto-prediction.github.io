// Risk Simulator. Scenarios are worked out in memory from the current paper portfolio and real return history.
// Nothing here writes to the database. Every figure is a model-based scenario, not a prediction.
import { correlation } from './portfolio.js';

export const SCENARIO_LABEL = 'Scenario estimates from a simple model and past returns, not guaranteed outcomes.';
const HOURS_PER_DAY = 24;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

/** How much a coin has tended to move for each 1% move in BTC, from real returns. Null if it can't be measured. */
export function betaToBtc(returns, btcReturns) {
  const n = Math.min(returns.length, btcReturns.length);
  if (n < 20) return null;
  const a = returns.slice(-n), b = btcReturns.slice(-n);
  const ma = mean(a), mb = mean(b);
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); varB += (b[i] - mb) ** 2; }
  return varB > 0 ? cov / varB : null;
}

/** Historical Value at Risk and Conditional VaR, as positive loss fractions, from a list of returns. */
export function historicalVar(returns, confidence) {
  if (returns.length < 20) return { var: null, cvar: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * (1 - confidence)));
  const tail = sorted.slice(0, cut);
  return { var: Math.max(0, -sorted[cut - 1]), cvar: Math.max(0, -mean(tail)) };
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });

export function normalizeScenario(raw = {}, isActive = () => true) {
  const range = (v, def, min, max, label) => {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}`);
    return n;
  };
  const shocks = {};
  for (const [symbol, pct] of Object.entries(raw.shocks || {})) {
    if (!isActive(symbol)) throw bad(`${symbol} is not available`);
    if (pct === '' || pct === null || pct === undefined) continue;
    shocks[symbol] = range(pct, 0, -100, 100, `${symbol} move`);
  }
  const hypothetical = (Array.isArray(raw.hypothetical) ? raw.hypothetical : []).slice(0, 20).map((h) => {
    if (!isActive(h?.symbol)) throw bad(`${h?.symbol} is not available`);
    return { symbol: h.symbol, value: range(h.valueUsd, 0, 0, 1e9, 'Position value') };
  }).filter((h) => h.value > 0);
  return {
    shocks,
    hypothetical,
    useCurrent: raw.useCurrent !== false,
    marketShockPct: range(raw.marketShockPct, 0, -100, 100, 'Market move'),
    correlated: Boolean(raw.correlated),
    volatilityMultiplier: range(raw.volatilityMultiplier, 1, 0.1, 10, 'Volatility multiplier'),
    feePct: range(raw.feePct, 0.1, 0, 5, 'Fee'),
    slippageBps: range(raw.slippageBps, 5, 0, 1000, 'Slippage'),
    liquidityFactor: range(raw.liquidityFactor, 1, 1, 50, 'Liquidity factor'),
  };
}

/**
 * positions: [{symbol, value}]. cash: uninvested cash. returnsBySymbol: real hourly returns, oldest first.
 * levels: optional {symbol: {price, support, resistance}} for risk/reward.
 */
export function simulateRisk({ positions, cash, returnsBySymbol, btcSymbol = 'BTCUSDT', levels = {} }, scenario) {
  const invested = positions.reduce((s, p) => s + p.value, 0);
  const equity = cash + invested;
  const btcReturns = returnsBySymbol[btcSymbol] || [];
  const btcShock = scenario.shocks[btcSymbol];
  const exitCost = scenario.feePct / 100 + (scenario.slippageBps * scenario.liquidityFactor) / 1e4;

  const rows = positions.map((p) => {
    const beta = p.symbol === btcSymbol ? 1 : betaToBtc(returnsBySymbol[p.symbol] || [], btcReturns);
    let shockPct = scenario.marketShockPct;
    let basis = scenario.marketShockPct ? 'Market move' : 'No move';
    if (scenario.correlated && btcShock !== undefined && p.symbol !== btcSymbol && beta !== null) {
      shockPct = btcShock * Math.max(0, beta);
      basis = `BTC move × beta ${beta.toFixed(2)}`;
    }
    if (scenario.shocks[p.symbol] !== undefined) {
      shockPct = scenario.shocks[p.symbol];
      basis = 'Your input';
    }
    const moveUsd = p.value * (shockPct / 100);
    const after = Math.max(0, p.value + moveUsd);
    const costUsd = after * exitCost;
    const level = levels[p.symbol];
    const rewardPct = level?.resistance ? (level.resistance / level.price - 1) * 100 : null;
    const riskPct = level?.support ? (1 - level.support / level.price) * 100 : null;
    return {
      symbol: p.symbol, value: p.value, shareOfEquityPct: equity ? (p.value / equity) * 100 : 0,
      beta, shockPct, basis, moveUsd, valueAfter: after, exitCostUsd: costUsd,
      support: level?.support ?? null, resistance: level?.resistance ?? null,
      rewardRisk: rewardPct !== null && riskPct ? rewardPct / riskPct : null,
    };
  });

  const moveUsd = rows.reduce((s, r) => s + r.moveUsd, 0);
  const costUsd = rows.reduce((s, r) => s + r.exitCostUsd, 0);

  // the portfolio's own past hourly returns at today's weights, scaled to one day and to the chosen volatility
  const held = positions.filter((p) => (returnsBySymbol[p.symbol] || []).length >= 2);
  const len = held.length ? Math.min(...held.map((p) => returnsBySymbol[p.symbol].length)) : 0;
  const portfolioReturns = !equity ? [] : Array.from({ length: len }, (_, k) => held.reduce((sum, p) => {
    const r = returnsBySymbol[p.symbol];
    return sum + (p.value / equity) * r[r.length - len + k];
  }, 0));
  const scale = Math.sqrt(HOURS_PER_DAY) * scenario.volatilityMultiplier;
  const v95 = historicalVar(portfolioReturns, 0.95);
  const v99 = historicalVar(portfolioReturns, 0.99);
  const usd = (x) => (x === null ? null : x * scale * equity);

  const shares = invested ? positions.map((p) => p.value / invested) : [];
  const concentration = shares.reduce((s, w) => s + w * w, 0);
  let pairWeight = 0, pairSum = 0;
  for (let i = 0; i < held.length; i++) {
    for (let j = i + 1; j < held.length; j++) {
      const a = returnsBySymbol[held[i].symbol], b = returnsBySymbol[held[j].symbol];
      const n = Math.min(a.length, b.length);
      const c = correlation(a.slice(-n), b.slice(-n));
      if (c === null) continue;
      const w = held[i].value * held[j].value;
      pairSum += c * w;
      pairWeight += w;
    }
  }

  return {
    label: SCENARIO_LABEL,
    equityBefore: equity,
    equityAfter: equity + moveUsd - costUsd,
    investedBefore: invested,
    cash,
    moveUsd,
    exitCostUsd: costUsd,
    totalImpactUsd: moveUsd - costUsd,
    drawdownPct: equity ? (Math.max(0, costUsd - moveUsd) / equity) * 100 : 0,
    positions: rows,
    concentration: {
      largestPct: shares.length ? Math.max(...shares) * 100 : 0,
      hhi: concentration,
      effectivePositions: concentration ? 1 / concentration : 0,
    },
    weightedCorrelation: pairWeight ? pairSum / pairWeight : null,
    dailyVolatilityPct: portfolioReturns.length ? std(portfolioReturns) * scale * 100 : null,
    var: {
      basis: `${portfolioReturns.length} real hourly returns at current weights, scaled to one day`,
      var95Usd: usd(v95.var), cvar95Usd: usd(v95.cvar), var99Usd: usd(v99.var), cvar99Usd: usd(v99.cvar),
    },
    assumptions: {
      exitCostPct: exitCost * 100,
      note: 'Assumes selling every position at the shocked price. Thin markets can cost far more than a fixed percentage.',
    },
  };
}
