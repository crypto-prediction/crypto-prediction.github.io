# Signal Lab architecture

## Two pages

| Page | URL | Code | Status |
|---|---|---|---|
| Dashboard | `/` | `client/index.html`, `client/src/main.jsx`, `client/src/App.jsx`, `client/src/components/*.jsx` | Protected. Read-only without explicit approval |
| Intelligence Lab | `/lab.html` | `client/lab.html`, `client/src/lab-main.jsx`, `client/src/components/lab/` | All new features go here |

The Lab imports the dashboard's styles and some of its components, and never changes them. It keeps its own WebSocket connection, and only the open tab fetches anything. The globe runs only on the dashboard.

## Protected UI

Branch `signal-lab-ui-protected` is the approved dashboard. The one approved difference is the Intelligence Lab link beside the title in `App.jsx`. It is absolutely positioned, so it takes no layout space, and `APPROVED_ADDITIONS` in the regression script allows only that exact text. Check against the branch after any change, with the app running:

```bash
python scripts/ui_regression.py
```

## Server

```
server/src/
  index.js            start-up, background jobs
  app.js              existing HTTP routes, browser WebSocket relay
  config.js, coins.js configuration, the one list of coins
  markets.js          which coins Binance currently lists
  binance/            REST client (retries, rate limits) and spot WebSocket streams
  indicators.js       RSI, MACD, EMA, Bollinger, volume, momentum, volatility
  analysis.js         research signal and market trend
  backtest.js         backtester
  paper.js            paper trading
  ai.js               the only code that calls the Anthropic API
  intel/              everything behind the Intelligence Lab
    routes.js         registers the intel routes and background jobs
    routes-research.js  replay, strategy builder, risk simulator, journal
    routes-markets.js   order book, futures, liquidations, exchanges
    routes-automation.js  calendar, reports, autopilot
    arena.js          community arena, with its own routes
    pdf.js            text-only PDF writer with no dependencies
```

Shared services are passed in through one context object: `historyFor` and `overviewFor` for market data, `cached` for short-lived caching and request de-duplication, `tickersNow` for live prices, and `paper` and `lookup` for the account. New modules use these rather than calling Binance on their own.

## Database

`strategy_orders` is written only when an approved strategy places a paper order, together with a hash of its rules. The Arena's verified results read that table, not the journal's strategy field, because journal notes can be edited later. `arena_verified_trades` keeps a percentage-only copy, so a paper account reset doesn't erase a verified record.

`server/src/schema.sql` runs at every start. It only adds tables, with `CREATE TABLE IF NOT EXISTS`, and it never alters or removes paper-trading data. Only `paper.js` writes to the `paper_*` tables.

## Data rules

- Prices and candles come from real sources only. If a source can't be read, the UI says so and shows no data in its place.
- Modelled estimates are labelled as estimates, and AI text as AI. When AI isn't available, answers are labelled as rule-based.
- Spot and derivatives data stay apart, and paper trading only ever uses Binance spot prices.
- Nothing trades automatically. A paper order always comes from an explicit click. Autopilot never receives the paper module.
- Calendar events and report sections keep their source. Missing data is reported as missing.

## Online demo

`npm --prefix client run build:demo` builds a static copy for GitHub Pages into `client/dist-demo`. `vite.demo.config.js` only swaps the two entry scripts for `src/demo/main-demo.jsx` and `src/demo/lab-demo.jsx`. These install `src/demo/shim.js` before the unchanged app starts. The shim answers `fetch('/api/...')` and the `/ws` socket in the browser (`src/demo/server.js`), with the same response shapes as the server. It imports the server's own modules, which are plain JavaScript: indicators, analysis, backtest, forecast, lab, futures and risk. Market data comes straight from Binance (`src/demo/binance.js`). The paper account and saved backtests live in the visitor's `localStorage` (`src/demo/paper.js`). Anything that needs the database, scheduled jobs, AI or a source without browser access returns HTTP 501 with an explanation. The workflow `.github/workflows/pages.yml` builds and publishes it on every push to `main`.

## Before hosting

The app has no authentication, and everything assumes one person on their own machine: the paper account, the Arena's local profile, and moderation. Before putting it on a network, add accounts, per-user data, moderator roles and request rate limits.

## Tests

```bash
npm run test:client
TEST_DATABASE_URL=postgres://signallab:signallab@localhost:5433/signallab_test npm run test:server
```

`TEST_DATABASE_URL` must point to a disposable database, because the tests drop and recreate tables. The port depends on your Docker setup.
