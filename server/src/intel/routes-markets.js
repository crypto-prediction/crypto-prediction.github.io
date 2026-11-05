// Routes for Phase 2: Order Book, Futures, Liquidations and Exchange Comparison.
import { config } from '../config.js';
import { createBinanceRest } from '../binance/rest.js';
import { createBookFeed, createOrderBook } from './orderbook.js';
import { createFutures } from './futures.js';
import { createLiquidationFeed, createLiquidations } from './liquidations.js';
import { createExchanges, EXCHANGES, NETWORK_MINUTES } from './exchanges.js';

export function attachMarkets(app, ctx) {
  const { pool, rest, markets, cached, wrap, sym, tickersNow, overviewFor, fetchImpl } = ctx;
  const futuresRest = ctx.futuresRest || createBinanceRest({ baseUrl: config.binanceFuturesRest });

  const orderBook = createOrderBook({ pool, rest, cached });
  const books = ctx.bookFeed || createBookFeed();
  const futures = createFutures({ futuresRest, cached, markets, tickersNow, overviewFor });
  const liquidationFeed = ctx.liquidationFeed || createLiquidationFeed({ pool, isTracked: markets.isActive });
  const liquidations = createLiquidations({ pool, futuresRest, cached, feed: liquidationFeed, perpetuals: futures.perpetuals });
  const exchanges = createExchanges({ rest, cached, fetchImpl: fetchImpl || globalThis.fetch });

  // ---- order book
  app.get('/api/orderbook', wrap(async (req, res) => res.json(await orderBook.snapshot(sym(req.query.symbol)))));
  app.get('/api/orderbook/history', wrap(async (req, res) => res.json(await orderBook.history(sym(req.query.symbol), req.query.hours))));

  // ---- futures
  app.get('/api/futures/overview', wrap(async (_req, res) => res.json(await futures.overview())));
  app.get('/api/futures/detail', wrap(async (req, res) => {
    const symbol = sym(req.query.symbol);
    const [detail, map] = await Promise.all([
      futures.detail(symbol),
      liquidations.map(symbol, '7d').catch(() => null),
    ]);
    // the liquidation estimate gives context here, and stays labelled as an estimate
    res.json({ ...detail, nearestEstimatedLiquidations: map ? { label: map.label, longZones: map.longZones.slice(0, 2), shortZones: map.shortZones.slice(0, 2) } : null });
  }));

  // ---- liquidations
  app.get('/api/liquidations/map', wrap(async (req, res) => res.json(await liquidations.map(sym(req.query.symbol), String(req.query.range || '7d')))));
  app.get('/api/liquidations/events', wrap(async (req, res) => res.json(await liquidations.events(sym(req.query.symbol), req.query.hours, req.query.limit))));

  // ---- exchange comparison
  app.get('/api/exchanges/config', (_req, res) => res.json({ exchanges: EXCHANGES, networkMinutes: NETWORK_MINUTES }));
  app.post('/api/exchanges/compare', wrap(async (req, res) => {
    const b = req.body || {};
    const tradeUsd = b.tradeUsd === undefined ? 1000 : Number(b.tradeUsd);
    if (!(tradeUsd >= 1 && tradeUsd <= 1e8)) return res.status(400).json({ error: 'Trade size must be between $1 and $100,000,000' });
    const withdrawalFeeUsd = b.withdrawalFeeUsd === undefined || b.withdrawalFeeUsd === '' ? 0 : Number(b.withdrawalFeeUsd);
    if (!(withdrawalFeeUsd >= 0 && withdrawalFeeUsd <= 1e6)) return res.status(400).json({ error: 'Enter a withdrawal fee of $0 or more' });
    const feesPct = {};
    for (const [id, v] of Object.entries(b.feesPct || {})) {
      const n = Number(v);
      if (!EXCHANGES[id] || !(n >= 0 && n <= 5)) return res.status(400).json({ error: 'Fees must be between 0% and 5%' });
      feesPct[id] = n;
    }
    res.json(await exchanges.compare(sym(b.symbol), { tradeUsd, feesPct, withdrawalFeeUsd, exchanges: Array.isArray(b.exchanges) ? b.exchanges : undefined }));
  }));

  function startJobs() {
    const sample = () => orderBook.sampleAll(markets.active()).catch((e) => console.warn(`[orderbook] ${e.message}`));
    const purge = () => liquidationFeed.purge().catch((e) => console.warn(`[liquidations] ${e.message}`));
    liquidationFeed.start();
    sample();
    purge();
    const a = setInterval(sample, 5 * 60e3);
    const b = setInterval(purge, 24 * 3600e3);
    return () => { clearInterval(a); clearInterval(b); liquidationFeed.stop(); };
  }

  return { books, orderBook, futures, liquidations, liquidationFeed, exchanges, startJobs };
}
