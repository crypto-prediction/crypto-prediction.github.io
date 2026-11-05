// Paper trading against a real PostgreSQL database.
// Requires TEST_PSQL_ARGS (psql connection args) or TEST_DATABASE_URL with the `pg` package installed.
import { test as nodeTest, before, after } from 'node:test';

const DB = process.env.TEST_DATABASE_URL || process.env.TEST_PSQL_ARGS;
const test = DB ? nodeTest : (name, fn) => nodeTest(name, { skip: 'set TEST_DATABASE_URL to a disposable PostgreSQL database' }, fn);
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPaper } from '../src/paper.js';

let pool;
const quotes = { BTCUSDT: 50000, ETHUSDT: 2500 };
let priceUp = true;
const getPrice = async (s) => {
  if (!priceUp) throw Object.assign(new Error(`Live ${s} price is unavailable`), { status: 503 });
  return { price: quotes[s], time: 1_700_000_000_000, source: 'binance-ws' };
};
const lookup = (s) => (priceUp && quotes[s] ? { price: quotes[s], eventTime: 1 } : null);
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

before(async () => {
  if (!DB) return;
  if (process.env.TEST_DATABASE_URL) {
    const { createPool } = await import('../src/db.js');
    pool = createPool(process.env.TEST_DATABASE_URL);
  } else {
    const { createPsqlPool } = await import('./support/psql-pool.js');
    pool = createPsqlPool(process.env.TEST_PSQL_ARGS.split(' '));
  }
  await pool.query('DROP TABLE IF EXISTS backtest_runs, paper_equity, paper_trades, paper_positions, paper_accounts CASCADE');
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
});
after(async () => pool && pool.end());

test('starts at $10,000 with no positions', async () => {
  const p = createPaper(pool, getPrice, { feeRate: 0.001, slippageBps: 10 });
  const pf = await p.portfolio(lookup);
  assert.equal(pf.mode, 'paper');
  assert.equal(pf.cash, 10000);
  assert.equal(pf.equity, 10000);
  assert.equal(pf.positions.length, 0);
});

test('buy, partial sell and full sell record exact fills, fees and P&L', async () => {
  const fee = 0.001, slip = 10;
  const p = createPaper(pool, getPrice, { feeRate: fee, slippageBps: slip });
  quotes.BTCUSDT = 50000;
  const buy = await p.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 1000 });
  const fill = 50000 * 1.001;
  near(buy.fill_price, fill);
  near(buy.fee, 1);
  near(buy.qty, 999 / fill, 1e-12);
  assert.equal(buy.price_source, 'binance-ws');
  let pf = await p.portfolio(lookup);
  near(pf.cash, 9000);
  near(pf.positions[0].costBasis, 1000);

  quotes.BTCUSDT = 55000;
  const half = buy.qty / 2;
  const s1 = await p.order({ symbol: 'BTCUSDT', side: 'SELL', qty: half });
  const sFill = 55000 * 0.999;
  near(s1.fill_price, sFill);
  near(s1.fee, half * sFill * fee);
  near(s1.realized_pnl, half * sFill * (1 - fee) - 500, 1e-6);
  near(s1.entry_price, fill);

  const s2 = await p.order({ symbol: 'BTCUSDT', side: 'SELL', closeAll: true });
  near(s2.qty, half, 1e-12);
  pf = await p.portfolio(lookup);
  assert.equal(pf.positions.length, 0, 'position closed');
  const expectedCash = 9000 + 2 * half * sFill * (1 - fee);
  near(pf.cash, expectedCash, 1e-6);
  near(pf.realizedPnl, expectedCash - 10000, 1e-6);
  near(pf.feesPaid, 1 + buy.qty * sFill * fee, 1e-6);
  assert.equal(pf.closedTrades, 2);
  assert.equal(pf.winRatePct, 100);
});

test('rejects orders it cannot fill honestly', async () => {
  const p = createPaper(pool, getPrice);
  await assert.rejects(p.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 1e9 }), /Not enough paper cash/);
  await assert.rejects(p.order({ symbol: 'ETHUSDT', side: 'SELL', amountUsd: 10 }), /hold no ETHUSDT/);
  await assert.rejects(p.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 0 }), /at least \$1/);
  await assert.rejects(p.order({ symbol: 'NOTACOINUSDT', side: 'BUY', amountUsd: 10 }), /Unsupported/);
  priceUp = false;
  await assert.rejects(p.order({ symbol: 'BTCUSDT', side: 'BUY', amountUsd: 10 }), /unavailable/);
  priceUp = true;
});

test('unpriced positions make equity unknown instead of guessed', async () => {
  const p = createPaper(pool, getPrice);
  await p.order({ symbol: 'ETHUSDT', side: 'BUY', amountUsd: 500 });
  priceUp = false;
  const pf = await p.portfolio(lookup);
  assert.equal(pf.equity, null);
  assert.equal(pf.allPositionsPriced, false);
  assert.equal(pf.positions[0].marketValue, null);
  priceUp = true;
});

test('equity snapshots and reset', async () => {
  const p = createPaper(pool, getPrice);
  await p.snapshot(lookup);
  const hist = await p.equityHistory();
  assert.ok(hist.length >= 1);
  await p.reset();
  const pf = await p.portfolio(lookup);
  assert.equal(pf.cash, 10000);
  assert.equal(pf.trades, 0);
  assert.equal(pf.positions.length, 0);
  assert.equal((await p.trades()).length, 0);
});
