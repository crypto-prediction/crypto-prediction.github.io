// Market intelligence computed from real readings, plus rule-based answers that work with no AI.
// Price data shows what is happening, not why, so nothing here claims a cause it can't know.
import { coinInfo } from '../coins.js';

const pct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const base = (s) => coinInfo(s).base;

/** coins: overview rows. tickers: 24h stats by symbol. trends: { '1h'|'4h'|'1d': overview rows }. */
export function marketBrief({ coins, tickers = {}, trends = {} }) {
  const ok = coins.filter((c) => !c.error);
  const up = ok.filter((c) => c.trend === 'Uptrend').length;
  const down = ok.filter((c) => c.trend === 'Downtrend').length;
  const changes = ok.map((c) => tickers[c.symbol]?.priceChangePercent).filter(Number.isFinite);
  const avgChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  let mood = 'Neutral';
  if (up - down >= Math.ceil(ok.length * 0.3) && (avgChange === null || avgChange > 0)) mood = 'Bullish';
  if (down - up >= Math.ceil(ok.length * 0.3) && (avgChange === null || avgChange < 0)) mood = 'Bearish';

  const strongest = [...ok].filter((c) => Number.isFinite(c.momentumPct)).sort((a, b) => b.momentumPct - a.momentumPct);
  const unusual = ok.flatMap((c) => {
    const flags = [];
    if (c.relativeVolume >= 2) flags.push(`volume ${c.relativeVolume.toFixed(1)}× its 20-candle average`);
    const ch = tickers[c.symbol]?.priceChangePercent;
    if (Number.isFinite(ch) && Math.abs(ch) >= 8) flags.push(`${pct(ch)} in 24h`);
    return flags.length ? [{ symbol: c.symbol, flags }] : [];
  });

  const risks = [];
  const overbought = ok.filter((c) => c.rsi >= 70).map((c) => base(c.symbol));
  const oversold = ok.filter((c) => c.rsi <= 30).map((c) => base(c.symbol));
  if (overbought.length) risks.push(`RSI at or above 70 (overbought): ${overbought.join(', ')}.`);
  if (oversold.length) risks.push(`RSI at or below 30 (oversold): ${oversold.join(', ')}.`);
  if (ok.length) {
    const vols = ok.map((c) => c.volatilityPct).filter(Number.isFinite).sort((a, b) => a - b);
    const median = vols[Math.floor(vols.length / 2)];
    const hot = ok.filter((c) => c.volatilityPct >= median * 1.5).map((c) => base(c.symbol));
    if (hot.length) risks.push(`Volatility well above the group's median: ${hot.join(', ')}.`);
  }
  const falling = ok.filter((c) => c.macdHistogram < 0).length;
  if (ok.length && falling / ok.length >= 0.7) risks.push(`MACD histogram is negative on ${falling} of ${ok.length} coins, so short-term momentum is broadly weak.`);
  if (mood === 'Bullish' && overbought.length >= 3) risks.push('Several coins are overbought while the market leans bullish, which has often preceded pullbacks, though not always.');
  if (!risks.length) risks.push('No RSI, volatility or MACD threshold is flagged right now. That does not mean low risk: crypto can move sharply without warning.');

  const timeframes = Object.keys(trends);
  const multiTimeframe = ok.map((c) => ({
    symbol: c.symbol,
    trends: Object.fromEntries(timeframes.map((tf) => [tf, trends[tf].find((x) => x.symbol === c.symbol)?.trend ?? null])),
  }));

  return {
    mood,
    moodBasis: `${up} coins in an uptrend, ${down} in a downtrend, ${ok.length - up - down} mixed; average 24h change ${pct(avgChange)}.`,
    breadth: { up, down, mixed: ok.length - up - down, total: ok.length },
    averageChangePct: avgChange,
    strongestMomentum: strongest.slice(0, 3).map((c) => ({ symbol: c.symbol, momentumPct: c.momentumPct })),
    weakestMomentum: strongest.slice(-3).reverse().map((c) => ({ symbol: c.symbol, momentumPct: c.momentumPct })),
    unusualActivity: unusual,
    risks,
    multiTimeframe,
  };
}

const findCoin = (question, coins) => coins.find((c) => {
  const info = coinInfo(c.symbol);
  return new RegExp(`\\b(${info.base}|${info.name})\\b`, 'i').test(question);
});

function describeCoin(c, ticker) {
  const parts = [
    `${coinInfo(c.symbol).name} is ${pct(ticker?.priceChangePercent)} over 24h.`,
    `Trend reads ${c.trend}, RSI ${Number.isFinite(c.rsi) ? c.rsi.toFixed(1) : 'n/a'}, MACD ${c.macdState ?? 'n/a'}.`,
    `10-candle momentum ${pct(c.momentumPct)}, volume ${Number.isFinite(c.relativeVolume) ? `${c.relativeVolume.toFixed(2)}×` : 'n/a'} its 20-candle average.`,
    `The research signal is ${c.signal ?? 'unavailable'}.`,
  ];
  return parts.join(' ');
}

/** Answers common questions from the readings alone. Unknown questions get the market summary, and say so. */
export function ruleBasedAnswer(question, { coins, tickers = {}, brief }) {
  const q = String(question || '');
  const ok = coins.filter((c) => !c.error);
  const coin = findCoin(q, ok);
  if (/\bwhy\b/i.test(q) && coin) {
    return `${describeCoin(coin, tickers[coin.symbol])} These readings describe the move, but they can't show its cause. Check the News tab for possible catalysts.`;
  }
  if (/momentum|strongest|leader/i.test(q)) {
    const [top] = brief.strongestMomentum;
    return top ? `${coinInfo(top.symbol).name} has the strongest 10-candle momentum at ${pct(top.momentumPct)}. Next: ${brief.strongestMomentum.slice(1).map((x) => `${base(x.symbol)} ${pct(x.momentumPct)}`).join(', ') || 'none'}.` : 'Momentum readings are unavailable right now.';
  }
  if (/unusual|abnormal|spike/i.test(q)) {
    return brief.unusualActivity.length
      ? `Unusual activity: ${brief.unusualActivity.map((u) => `${base(u.symbol)} (${u.flags.join(', ')})`).join('; ')}.`
      : 'No coin is past the unusual-activity thresholds: volume at 2× its average, or a 24h move of 8%.';
  }
  if (/bullish|bearish|neutral|mood|sentiment/i.test(q)) return `The market reads ${brief.mood}. ${brief.moodBasis}`;
  if (/risk|danger/i.test(q)) return brief.risks.join(' ');
  if (coin) return describeCoin(coin, tickers[coin.symbol]);
  return `I can only answer this from market readings without AI. The market reads ${brief.mood}: ${brief.moodBasis}`;
}

export const CHAT_SYSTEM = `You are the market analyst inside Signal Lab, a crypto research and paper-trading dashboard.
Answer using only the JSON market readings in the user's message. Say when the readings can't answer the question.
Price data shows what is happening, not why, so don't state a cause as fact. Never promise returns or tell the user to trade.
Keep answers to a short paragraph, with no headings. This is research, not financial advice.`;
