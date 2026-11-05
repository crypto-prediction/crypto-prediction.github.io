// Logic behind the Intelligence Lab page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heatmapRows } from '../src/components/lab/heatmap.js';

test('heatmap filters only remove or reorder real rows, and missing data stays missing', () => {
  const symbols = ['A', 'B', 'C', 'D'];
  const tickers = { A: { lastPrice: 1, priceChangePercent: 5, quoteVolume: 10 }, B: { lastPrice: 2, priceChangePercent: -2, quoteVolume: 30 }, C: { lastPrice: 3, priceChangePercent: 9, quoteVolume: 20 } };
  const overview = { A: { volatilityPct: 1, trend: 'Uptrend', signal: 'HOLD' }, B: { volatilityPct: 3, trend: 'Downtrend', signal: 'SELL' }, C: { volatilityPct: 2, trend: 'Mixed', signal: 'BUY' } };
  const names = (f) => heatmapRows(symbols, tickers, overview, f).map((r) => r.symbol);
  assert.deepEqual(names('all'), symbols);
  assert.deepEqual(names('gainers'), ['C', 'A']);
  assert.deepEqual(names('losers'), ['B']);
  assert.deepEqual(names('volume'), ['B', 'C', 'A']);
  assert.deepEqual(names('volatility'), ['B', 'C', 'A']);
  assert.deepEqual(names('bullish'), ['A', 'C']);
  assert.deepEqual(names('bearish'), ['B']);
  const d = heatmapRows(symbols, tickers, overview).find((r) => r.symbol === 'D');
  assert.deepEqual([d.price, d.change, d.volume, d.volatility, d.trend], [null, null, null, null, null]);
});
