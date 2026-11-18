// The online demo's in-browser paper account follows the same rules as the server's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaper, PaperError } from '../src/demo/paper.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};
const setup = (price = 100) => {
  const storage = memoryStorage();
  let current = price;
  const paper = createPaper({ getPrice: async () => ({ price: current, time: Date.now(), source: 'binance-ws' }), isTradable: (s) => s === 'BTCUSDT', storage });
  return { paper, storage, setPrice: (p) => { current = p; }, lookup: () => ({ price: current, eventTime: Date.now() }) };
};

test('buying and selling charge the fee and slippage, and realised P&L is exact', async () => {
  const { paper, setPrice, lookup } = setup(100);
  const buy = await paper.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 1000 });
  assert.equal(buy.fill_price, 100 * 1.0005);
  assert.equal(buy.fee, 1);
  assert.ok(Math.abs(buy.qty - 999 / 100.05) < 1e-12);
  assert.equal(paper.portfolio(lookup).cash, 9000);

  setPrice(110);
  const sell = await paper.order({ symbol: 'BTCUSDT', side: 'SELL', closeAll: true });
  const gross = buy.qty * 110 * 0.9995;
  assert.ok(Math.abs(sell.realized_pnl - (gross * 0.999 - 1000)) < 1e-9);
  const pf = paper.portfolio(lookup);
  assert.equal(pf.positions.length, 0);
  assert.equal(pf.closedTrades, 1);
  assert.equal(pf.winRatePct, 100);
});

test('bad orders are refused and change nothing', async () => {
  const { paper, lookup } = setup();
  await assert.rejects(paper.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 20000 }), PaperError);
  await assert.rejects(paper.order({ symbol: 'BTCUSDT', side: 'SELL', closeAll: true }), /hold no/);
  await assert.rejects(paper.order({ symbol: 'EVILUSDT', side: 'BUY', amountUsd: 10 }), /Unsupported/);
  await assert.rejects(paper.order({ symbol: 'BTCUSDT', side: 'HOLD', amountUsd: 10 }), /BUY or SELL/);
  assert.equal(paper.portfolio(lookup).cash, 10000);
  assert.equal(paper.trades().length, 0);
});

test('no live price means no order', async () => {
  const paper = createPaper({ getPrice: async () => { throw new Error('price unavailable'); }, isTradable: () => true, storage: memoryStorage() });
  await assert.rejects(paper.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 10 }), /unavailable/);
});

test('the account is kept in browser storage and survives a reload, and reset starts over', async () => {
  const { paper, storage, lookup } = setup();
  await paper.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 500 });
  const again = createPaper({ getPrice: async () => ({ price: 100, time: Date.now(), source: 'x' }), isTradable: () => true, storage });
  assert.equal(again.portfolio(lookup).cash, 9500);
  assert.equal(again.trades().length, 1);
  again.reset();
  assert.equal(again.portfolio(lookup).cash, 10000);
  assert.equal(again.trades().length, 0);
});

test('equity is never recorded without a live price', async () => {
  const { paper } = setup();
  await paper.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 500 });
  paper.snapshot(() => null);
  assert.equal(paper.equityHistory().length, 0);
  assert.equal(paper.portfolio(() => null).equity, null);
});
