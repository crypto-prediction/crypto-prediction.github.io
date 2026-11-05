# Signal Lab architecture

## Two pages

| Page | URL | Code | Status |
|---|---|---|---|
| Dashboard | `/` | `client/index.html`, `client/src/main.jsx`, `client/src/App.jsx`, `client/src/components/*.jsx` | Protected. Read-only without explicit approval |
| Intelligence Lab | `/lab.html` | `client/lab.html`, `client/src/lab-main.jsx`, `client/src/components/lab/` | All new features go here |

The Lab imports the dashboard's styles and some of its components, and never changes them. It keeps its own WebSocket connection, and only the open tab fetches anything. The globe runs only on the dashboard.

## Protected UI

Branch `signal-lab-ui-protected` is the approved dashboard. Check against it after any change, with the app running:

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
```

Shared services are passed in through one context object: `historyFor` and `overviewFor` for market data, `cached` for short-lived caching and request de-duplication, `tickersNow` for live prices, and `paper` and `lookup` for the account. New modules use these rather than calling Binance on their own.

## Database

`server/src/schema.sql` runs at every start. It only adds tables, with `CREATE TABLE IF NOT EXISTS`, and it never alters or removes paper-trading data. Only `paper.js` writes to the `paper_*` tables.

## Data rules

- Prices and candles come from real sources only. If a source can't be read, the UI says so and shows no data in its place.
- Modelled estimates are labelled as estimates, and AI text as AI. When AI isn't available, answers are labelled as rule-based.
- Spot and derivatives data stay apart, and paper trading only ever uses Binance spot prices.
- Nothing trades automatically. A paper order always comes from an explicit click.

## Tests

```bash
npm run test:client
TEST_DATABASE_URL=postgres://signallab:signallab@localhost:5433/signallab_test npm run test:server
```

`TEST_DATABASE_URL` must point to a disposable database, because the tests drop and recreate tables. The port depends on your Docker setup.
