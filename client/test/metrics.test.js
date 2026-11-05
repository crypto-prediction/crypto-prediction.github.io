// Frontend logic: price formatting across very different coin prices, the coin registry, and chart maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtSig, price, pricePrecision } from '../src/format.js';
import { baseOf, nameOf, pairColor, setCoins } from '../src/coins.js';
import { activityLevel, correlation, median, ranks, returns, strongestLinks, topSlices } from '../src/metrics.js';

test('prices keep useful decimals from BTC down to DOGE', () => {
  assert.equal(price(80420.012), '80,420.01');
  assert.equal(price(2420.39), '2,420.39');
  assert.equal(price(96.12), '96.12');
  assert.equal(price(2.34567), '2.3457');
  assert.equal(price(0.15234), '0.15234', 'a 2-decimal format would show DOGE as 0.15');
  assert.equal(price(0.000012), '0.00001200');
  assert.equal(pricePrecision(0.5), 5);
  assert.equal(price(null), '—');
});

test('tiny indicator values stay visible', () => {
  assert.equal(fmtSig(0.0000312), '0.0000312');
  assert.equal(fmtSig(-12.3456), '-12.3');
  assert.equal(fmtSig(0), '0');
  assert.equal(fmtSig(null), '—');
});

test('the coin registry reads server-provided details and copes with an unknown symbol', () => {
  setCoins([{ symbol: 'DOGEUSDT', base: 'DOGE', name: 'Dogecoin', color: '#D9683A' }]);
  assert.equal(baseOf('DOGEUSDT'), 'DOGE');
  assert.equal(nameOf('DOGEUSDT'), 'Dogecoin');
  assert.equal(pairColor('DOGEUSDT'), '#D9683A');
  assert.equal(baseOf('PEPEUSDT'), 'PEPE');
  assert.equal(nameOf('PEPEUSDT'), 'PEPE');
  assert.match(pairColor('PEPEUSDT'), /^#/);
  setCoins([]);
});

test('median and ranks', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  assert.deepEqual(ranks([10, 30, 20]), [0, 1, 0.5]);
});

test('correlation matches known cases and refuses what cannot be measured', () => {
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(correlation([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), null);
  assert.equal(correlation([1], [1]), null);
  // textbook example: r = 0.7746 for these two series
  assert.ok(Math.abs(correlation([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]) - 0.7746) < 0.0001);
});

test('strongest links rank real pairs and ignore the forming candle', () => {
  const candles = (closes) => closes.map((close, i) => ({ close, closed: i < closes.length - 1 }));
  const a = [100, 101, 103, 102, 105, 107, 106, 999];
  const b = a.map((x) => x * 2); // moves exactly with a, apart from the forming candle below
  b[b.length - 1] = 1;
  const c = [50, 49, 50, 52, 50, 49, 51, 50];
  const links = strongestLinks([{ symbol: 'A', candles: candles(a) }, { symbol: 'B', candles: candles(b) }, { symbol: 'C', candles: candles(c) }], 2);
  assert.equal(links.length, 2);
  assert.deepEqual([links[0].a, links[0].b], [0, 1]);
  assert.ok(Math.abs(links[0].value - 1) < 1e-9, 'the forming candle must not count');
});

test('returns are bar to bar', () => {
  assert.deepEqual(returns([100, 110]), [0.10000000000000009]);
});

test('a pie folds small parts into Other but keeps totals and never hides a single part', () => {
  const parts = Array.from({ length: 10 }, (_, i) => ({ label: `C${i}`, value: 10 - i, color: '#000' }));
  const out = topSlices(parts, 5);
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(0, 5).map((s) => s.label), ['C0', 'C1', 'C2', 'C3', 'C4']);
  assert.equal(out[5].label, 'Other (5)');
  assert.equal(out[5].value, 15);
  assert.equal(out.reduce((s, x) => s + x.value, 0), 55);
  assert.equal(topSlices(parts.slice(0, 6), 5).length, 6, 'one leftover part is shown as itself');
});

test('activity comes from relative volume, with nothing shown when there is no reading', () => {
  assert.equal(activityLevel(1), 0.5);
  assert.equal(activityLevel(5), 1);
  assert.equal(activityLevel(0), 0);
  assert.equal(activityLevel(null), 0);
  assert.equal(activityLevel(NaN), 0);
});
