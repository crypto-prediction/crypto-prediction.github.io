import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSymbols } from './coins.js';

// Load server/.env if present (Node 20.12+ built-in; no dotenv dependency needed)
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://signallab:signallab@localhost:5432/signallab',
  // Binance public market-data endpoints. data-api.binance.vision is Binance's
  // market-data-only mirror; set BINANCE_REST_URL to it if api.binance.com is blocked in your region.
  binanceRest: process.env.BINANCE_REST_URL || 'https://api.binance.com',
  binanceWs: process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443',
  // Derivatives data only, kept apart from the spot feed. Binance moved futures streams to these routed paths in 2026;
  // the old base URL still connects but sends nothing.
  binanceFuturesRest: process.env.BINANCE_FUTURES_REST_URL || 'https://fapi.binance.com',
  binanceFuturesWs: process.env.BINANCE_FUTURES_WS_URL || 'wss://fstream.binance.com/market',
  symbols: resolveSymbols(process.env.SYMBOLS), // defined in coins.js
  // A live price older than this is treated as stale: paper trades are refused.
  staleAfterMs: num(process.env.STALE_AFTER_MS, 15000),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  paper: {
    startingBalance: 10000,
    feeRate: num(process.env.PAPER_FEE_RATE, 0.001), // 0.1% Binance spot taker
    slippageBps: num(process.env.PAPER_SLIPPAGE_BPS, 5),
  },
};

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
