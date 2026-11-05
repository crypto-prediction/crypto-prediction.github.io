import http from 'node:http';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createBinanceRest } from './binance/rest.js';
import { createBinanceStream } from './binance/stream.js';
import { createApp, attachWs } from './app.js';
import { createMarkets } from './markets.js';

const pool = createPool();
try {
  await migrate(pool);
} catch (e) {
  console.error(`Cannot connect to PostgreSQL at ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')}\n${e.message}\nStart it with: docker compose up -d db`);
  process.exit(1);
}

const rest = createBinanceRest();
let stream = null;
const markets = createMarkets({ rest, onChange: (active) => stream?.setSymbols(active) });
const verified = await markets.start();
const { unavailable } = markets.status();
if (!verified) console.warn(`[markets] could not verify pairs with Binance (${markets.status().lastError}); using the configured list and retrying`);
for (const [s, why] of Object.entries(unavailable)) console.warn(`[markets] ${s} disabled: ${why}`);
console.log(`[markets] ${markets.active().length} of ${markets.status().configured} pairs enabled`);

stream = createBinanceStream({ symbols: markets.active() });
stream.on('status', (s) => console.log(`[binance-ws] ${s.status}${s.lastError ? ` — ${s.lastError}` : ''}`));
stream.start();

const { app, paper, lookup } = createApp({ pool, rest, stream, markets });
const server = http.createServer(app);
attachWs(server, stream);

paper.snapshot(lookup).catch(() => {}); // registers the live-price lookup
// equity snapshot every minute, only when every position has a live price
setInterval(() => paper.snapshot(lookup).catch((e) => console.error('snapshot', e.message)), 60000);

server.listen(config.port, () => console.log(`Signal Lab API on http://localhost:${config.port}  (Binance REST ${config.binanceRest})`));

const shutdown = () => { markets.stop(); stream.stop(); server.close(); pool.end().finally(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
