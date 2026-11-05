// Futures Intelligence: Binance USD-M perpetual data. It is kept apart from spot: nothing here feeds the
// spot prices, signals or paper trading. The funding, open interest and ratios are as reported by Binance.
import { median } from './http.js';

export const FUTURES_SOURCE = 'Binance USD-M perpetual futures';

const percentileOf = (values, x) => (values.length ? values.filter((v) => v <= x).length / values.length : null);
const pct = (v, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`;

/** Plain-language readings from the numbers. Rule-based, and written to describe rather than to predict. */
export function analyzeDerivatives({ row, fundingHistory = [], spotTrend = null }) {
  const findings = [];
  const rates = fundingHistory.map((f) => f.fundingRatePct);
  const typical = median(rates);
  const rank = percentileOf(rates, row.fundingRatePct);
  const r = row.fundingRatePct;
  let fundingUnusual = 0;
  if (rank !== null && rank >= 0.9 && r > 0) fundingUnusual = 1;
  if (rank !== null && rank <= 0.1 && r < 0) fundingUnusual = -1;
  findings.push({
    topic: 'Funding',
    reading: fundingUnusual > 0 ? 'Unusually positive' : fundingUnusual < 0 ? 'Unusually negative' : 'Usual range',
    text: `Funding is ${pct(r, 4)} per 8 hours${typical !== null ? `, against a typical ${pct(typical, 4)} over the last ${rates.length} payments` : ''}. ${r >= 0 ? 'Longs are paying shorts.' : 'Shorts are paying longs.'}`,
  });

  const ls = row.longShortRatio;
  let crowd = 'No clear sign';
  let crowdText = 'Neither funding nor the long/short ratio points to one crowded side.';
  if (ls !== null && (fundingUnusual > 0 || ls >= 2.5)) {
    crowd = 'Longs may be crowded';
    crowdText = `Long accounts outnumber shorts ${ls.toFixed(2)} to 1${fundingUnusual > 0 ? ', and funding is high for this coin' : ''}. Crowded positioning can unwind quickly, but it can also last.`;
  } else if (ls !== null && (fundingUnusual < 0 || ls <= 0.7)) {
    crowd = 'Shorts may be crowded';
    crowdText = `The long/short account ratio is ${ls.toFixed(2)}${fundingUnusual < 0 ? ', and funding is unusually negative' : ''}. Crowded positioning can unwind quickly, but it can also last.`;
  }
  findings.push({ topic: 'Leverage', reading: crowd, text: crowdText });

  const oi = row.oiChange24hPct;
  findings.push({
    topic: 'Open interest',
    reading: oi === null ? 'Unknown' : oi >= 3 ? 'Increasing' : oi <= -3 ? 'Decreasing' : 'Steady',
    text: oi === null ? 'Open interest history is unavailable.' : `Open interest is ${pct(oi, 1)} over 24 hours, which means ${oi >= 3 ? 'positions are being added' : oi <= -3 ? 'positions are being closed' : 'little net change in positions'}.`,
  });

  const change = row.spotChange24hPct;
  let conflict = 'No clear conflict';
  let conflictText = 'Derivatives readings and the spot trend are not pulling in obvious opposite directions.';
  if (spotTrend === 'Uptrend' && r < 0) {
    conflict = 'Conflict';
    conflictText = 'Spot is in an uptrend while funding is negative, so leveraged traders are leaning against the move.';
  } else if (spotTrend === 'Downtrend' && fundingUnusual > 0) {
    conflict = 'Conflict';
    conflictText = 'Spot is in a downtrend while funding is unusually positive, so leveraged longs are still paying up.';
  } else if (change !== null && oi !== null && change <= -2 && oi >= 3) {
    conflict = 'Worth watching';
    conflictText = `Spot is ${pct(change, 1)} over 24 hours while open interest rose ${pct(oi, 1)}, so new positions are being opened into the fall.`;
  } else if (change !== null && oi !== null && change >= 2 && oi <= -3) {
    conflict = 'Worth watching';
    conflictText = `Spot is ${pct(change, 1)} over 24 hours while open interest fell ${pct(oi, 1)}, which can mean shorts closing rather than new buying.`;
  }
  findings.push({ topic: 'Against spot', reading: conflict, text: conflictText });
  return findings;
}

export function createFutures({ futuresRest, cached, markets, tickersNow, overviewFor }) {
  const perpetuals = () => cached('futures:perps', 6 * 3600e3, async () => {
    const info = await futuresRest.request('/fapi/v1/exchangeInfo');
    return new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING').map((s) => s.symbol));
  });

  async function row(symbol, spot) {
    const [premium, ticker, oi, ls] = await Promise.all([
      futuresRest.request('/fapi/v1/premiumIndex', { symbol }),
      futuresRest.request('/fapi/v1/ticker/24hr', { symbol }),
      futuresRest.request('/futures/data/openInterestHist', { symbol, period: '1h', limit: 25 }),
      futuresRest.request('/futures/data/globalLongShortAccountRatio', { symbol, period: '1h', limit: 1 }),
    ]);
    const mark = Number(premium.markPrice);
    const oiNow = oi.at(-1) ? Number(oi.at(-1).sumOpenInterestValue) : null;
    const oiThen = oi[0] ? Number(oi[0].sumOpenInterestValue) : null;
    const fundingRatePct = Number(premium.lastFundingRate) * 100;
    return {
      symbol,
      markPrice: mark,
      indexPrice: Number(premium.indexPrice),
      lastPrice: Number(ticker.lastPrice),
      futuresChange24hPct: Number(ticker.priceChangePercent),
      futuresVolumeUsd: Number(ticker.quoteVolume),
      fundingRatePct,
      fundingAnnualizedPct: fundingRatePct * 3 * 365,
      nextFundingTime: premium.nextFundingTime,
      openInterestUsd: oiNow,
      oiChange24hPct: oiNow && oiThen ? (oiNow / oiThen - 1) * 100 : null,
      longShortRatio: ls[0] ? Number(ls[0].longShortRatio) : null,
      longAccountPct: ls[0] ? Number(ls[0].longAccount) * 100 : null,
      spotPrice: spot?.lastPrice ?? null,
      spotChange24hPct: spot?.priceChangePercent ?? null,
      basisPct: spot?.lastPrice ? (mark / spot.lastPrice - 1) * 100 : null,
      asOf: premium.time,
    };
  }

  async function overview() {
    return cached('futures:overview', 120000, async () => {
      const perps = await perpetuals();
      const { tickers } = await tickersNow();
      const spot = Object.fromEntries(tickers.map((t) => [t.symbol, t]));
      const coins = await Promise.all(markets.active().map(async (symbol) => {
        if (!perps.has(symbol)) return { symbol, unavailable: 'Binance lists no USDT perpetual for this coin' };
        try {
          return await row(symbol, spot[symbol]);
        } catch (e) {
          return { symbol, unavailable: e.message };
        }
      }));
      return { source: FUTURES_SOURCE, fetchedAt: Date.now(), coins };
    });
  }

  async function detail(symbol) {
    return cached(`futures:detail:${symbol}`, 120000, async () => {
      const perps = await perpetuals();
      if (!perps.has(symbol)) throw Object.assign(new Error('Binance lists no USDT perpetual for this coin'), { status: 404 });
      const { tickers } = await tickersNow();
      const spot = tickers.find((t) => t.symbol === symbol);
      const [current, funding, oi, ls, taker, trends] = await Promise.all([
        row(symbol, spot),
        futuresRest.request('/fapi/v1/fundingRate', { symbol, limit: 200 }),
        futuresRest.request('/futures/data/openInterestHist', { symbol, period: '1h', limit: 168 }),
        futuresRest.request('/futures/data/globalLongShortAccountRatio', { symbol, period: '1h', limit: 168 }),
        futuresRest.request('/futures/data/takerlongshortRatio', { symbol, period: '1h', limit: 24 }),
        overviewFor('1h'),
      ]);
      const fundingHistory = funding.map((f) => ({ time: f.fundingTime, fundingRatePct: Number(f.fundingRate) * 100, markPrice: Number(f.markPrice) }));
      const spotTrend = trends.find((c) => c.symbol === symbol)?.trend ?? null;
      return {
        source: FUTURES_SOURCE,
        fetchedAt: Date.now(),
        current,
        spotTrend,
        fundingHistory,
        openInterestHistory: oi.map((x) => ({ time: x.timestamp, usd: Number(x.sumOpenInterestValue), contracts: Number(x.sumOpenInterest) })),
        longShortHistory: ls.map((x) => ({ time: x.timestamp, ratio: Number(x.longShortRatio), longPct: Number(x.longAccount) * 100 })),
        takerBuySell: taker.map((x) => ({ time: x.timestamp, ratio: Number(x.buySellRatio) })),
        findings: analyzeDerivatives({ row: current, fundingHistory, spotTrend }),
      };
    });
  }

  return { overview, detail, perpetuals };
}
