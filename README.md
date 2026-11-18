# Signal Lab

**Crypto research, backtesting and paper trading on real Binance market data.**

Signal Lab follows 10 Binance spot pairs (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK, AVAX and LTC, each against USDT). The dashboard has live prices, technical indicators, a rule-based research signal, a backtester and a $10,000 paper-trading account. A separate **Intelligence Lab** adds forecasting, order-book and futures data, an economic calendar, research reports, a strategy builder, market replay, a risk simulator, a trading journal, a community arena and an automated research assistant.

Nothing in the app makes up prices or market events. When a source can't be reached, the page says so and shows nothing in its place. Estimates are labelled as estimates, and AI text is labelled as AI.

> Signal Lab is for research and education. It is not financial advice, and it never trades real money.

**Try it online: [crypto-prediction.github.io](https://crypto-prediction.github.io/)**. The online demo runs entirely in your browser, with live data straight from Binance. See [Online demo](#online-demo) for what it includes.

![The Signal Lab dashboard](docs/images/dashboard.png)

## Contents

- [Features](#features)
- [Online demo](#online-demo)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How the numbers work](#how-the-numbers-work)
- [Safety and data rules](#safety-and-data-rules)
- [Architecture](#architecture)
- [API](#api)
- [Tests](#tests)
- [Protected UI](#protected-ui)
- [Known limitations](#known-limitations)

## Features

### Dashboard

- Live prices for 10 pairs over the Binance WebSocket, with REST as a fallback.
- An animated 3D globe in which every moving particle stands for real market data.
- Candlestick charts with RSI, MACD, EMA 20/50/200, Bollinger Bands, volume and on-balance volume.
- A rule-based BUY / SELL / HOLD research signal, shown with how often similar past readings worked out.
- A backtester with fees, slippage, out-of-sample testing and warnings.
- A $10,000 paper-trading account stored in PostgreSQL, filled at live prices.

### Intelligence Lab

Open it with the **Intelligence Lab** button beside the dashboard title, or go to `http://localhost:5173/lab.html`. It's a separate page: only the open tab fetches data, and it adds no load to the dashboard.

![Forecasts in the Intelligence Lab](docs/images/lab-forecasts.png)

| Group | Tab | What it does | Data source |
|---|---|---|---|
| Markets | Heatmap | Price, change, volume, volatility and direction for every coin, with filters | Binance |
| | Activity | Unusual volume, sudden moves and large unconfirmed BTC transfers | Binance, blockchain.info |
| | Order book | Live top of book, depth chart, buy/sell imbalance, large visible orders | Binance spot depth |
| | Futures | Funding, open interest, long/short ratio and basis, kept separate from spot | Binance USD-M perpetuals |
| | Liquidations | A modelled liquidation heatmap, always labelled as an estimate, next to liquidations Binance actually reported | Binance |
| | Exchanges | Bid, ask, spread, depth and costs across exchanges, with a theoretical difference that is never traded | Binance, Coinbase, Kraken, OKX, Bybit |
| Research | Forecasts | Direction, probabilities, price range, support and resistance for 5 horizons | Statistical model on Binance candles |
| | Analyst | Market mood, risks, multi-timeframe trend, and a chat | Binance, with Claude when available |
| | Model tracker | Accuracy, Brier score and calibration of saved forecasts against real outcomes | Real outcomes only |
| | News | Latest crypto news, filtered by coin | CoinDesk, Cointelegraph, Decrypt |
| | Calendar | Economic events: month view, upcoming events, importance, previous and forecast values, source links | ForexFactory, Federal Reserve, SEC, CFTC |
| | Reports | Daily and per-coin research reports, an archive, date ranges, PDF export | The modules above |
| Strategy | Strategy builder | Describe a strategy in words. It becomes validated rules you review, approve and backtest | Binance, with Claude when available |
| | Backtest lab | Compare coins, strategies and timeframes, with walk-forward validation | Binance history |
| | Market replay | Step through past candles and practise orders, optionally with a built strategy | Binance history |
| | Arena | Publish strategies and compare them on several risk-aware measures | Computed by the server |
| Portfolio | Portfolio | Exposure, profit and loss, risk and correlation | Paper account, read only |
| | Risk simulator | Market shocks, Value at Risk and expected shortfall on your current holdings | Paper account, read only |
| | Trading journal | Your paper trades as round trips, with notes and a review | Paper trades, read only |
| Automation | Alerts | Price, indicator and forecast alerts, checked on the server every 30 seconds | Binance |
| | Autopilot | Scheduled market research with findings, an activity log and an audit log. Off by default, and it cannot trade | Shared market-data services |

![The market heatmap](docs/images/lab-heatmap.png)

## Online demo

**[crypto-prediction.github.io](https://crypto-prediction.github.io/)** is hosted free on GitHub Pages. GitHub Pages can only serve static files, so the demo has no server or database. Instead, a small layer in the browser (`client/src/demo/`) answers the app's requests by calling Binance directly. It runs the same indicator, signal, backtest, forecast, futures and risk code as the server. The dashboard and Lab code are exactly the same as in the full app.

| In the online demo | Only in the full app |
|---|---|
| Live prices, charts, indicators, the research signal and the globe | Model tracker, which needs forecasts saved over time |
| Backtests, saved in your browser | Alerts, Autopilot and daily reports, which run on the server |
| Paper trading: your own $10,000 account, saved only in your browser | News, Calendar and Exchanges, whose sources don't allow browser requests |
| Lab: Heatmap, Forecasts, Futures, Backtest lab, Risk simulator | Order book, Liquidations, Activity, Analyst, Strategy builder, Replay, Journal, Portfolio, Arena |

Tabs that need the full app say so. Every push to `main` rebuilds and republishes the demo (`.github/workflows/pages.yml`). To build it yourself, run `npm --prefix client run build:demo`.

If Binance blocks your region, the demo switches to Binance's public data mirror for spot prices. Futures data has no mirror, so the Futures tab may be unavailable there.

## Quick start

You need **Node.js 20+** and **Docker**, or your own PostgreSQL 14+.

```bash
git clone https://github.com/crypto-prediction/crypto-prediction.github.io.git crypto-prediction
cd crypto-prediction
npm run install:all                 # installs server/ and client/ dependencies
npm run db                          # starts PostgreSQL in Docker on port 5432
cp server/.env.example server/.env
npm run server                      # API and WebSocket relay on http://localhost:4000
npm run client                      # web app on http://localhost:5173
```

Then open **http://localhost:5173**. The server creates its tables when it starts. No Binance account or key is needed, because only public market data is used.

**Port 5432 already in use?** Create a `docker-compose.override.yml` that publishes the database on another port, such as `"5433:5432"`, then change the port in `DATABASE_URL` in `server/.env` to match. Git ignores that file, so it stays on your machine.

**Binance blocked in your region?** If you see HTTP 451, set these in `server/.env`:

```
BINANCE_REST_URL=https://data-api.binance.vision
BINANCE_WS_URL=wss://data-stream.binance.vision
```

## Configuration

All settings live in `server/.env`. The app runs without any keys.

| Setting | Needed? | What it does |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection. The default matches `docker-compose.yml`. |
| `PORT` | No | API port, 4000 by default. |
| `ANTHROPIC_API_KEY` | Optional | Turns on AI features: explanations, chat, strategy parsing, news digests and report summaries. The account needs credits. Without a key, each of these falls back to a rule-based version, labelled as not AI. |
| `ANTHROPIC_MODEL` | Optional | Which Claude model to use. |
| `FRED_API_KEY` | Optional | Adds actual US release values (CPI, jobs, GDP and more) to the Calendar. Free from [FRED](https://fred.stlouisfed.org/docs/api/api_key.html). |
| `SYMBOLS` | Optional | Narrows the coin list or adds a pair. The full list is in `server/src/coins.js`. |
| `BINANCE_*_URL` | Optional | Other Binance endpoints, for example in regions where the main ones are blocked. |

Restart the server after changing `.env`.

**External services**

| Service | Key | Used for |
|---|---|---|
| Binance spot and USD-M futures (public data) | None | All prices, candles, order books and futures data |
| Coinbase, Kraken, OKX, Bybit (public data) | None | Exchange comparison |
| CoinDesk, Cointelegraph, Decrypt RSS | None | News |
| ForexFactory weekly calendar | None | Economic events for the current week, with no actual values |
| Federal Reserve, SEC, CFTC | None | FOMC meeting dates and published press releases |
| blockchain.info | None | Sample of large unconfirmed Bitcoin transfers |
| Anthropic API | `ANTHROPIC_API_KEY` | Optional AI features |
| FRED | `FRED_API_KEY` | Optional actual values in the Calendar |
| Crypto events provider | Not connected | No reliable free source, so network upgrades, token unlocks and conferences aren't listed |
| On-chain flows provider | Not connected | Exchange inflows and outflows need a paid provider |

**Adding a coin:** add one line to `server/src/coins.js`. Everything else reads that list. At startup and every 6 hours, the server checks the list against Binance. A pair Binance doesn't list is disabled with a visible reason, and the others carry on.

## How the numbers work

### Research signal

Six indicator readings at the **last closed candle** are each scored from −1 to +1:

| Reading | Weight |
|---|---|
| Price vs EMA 200 | 30% |
| EMA 20 vs EMA 50 | 20% |
| MACD histogram | 20% |
| RSI | 15% |
| Bollinger %B | 10% |
| Volume | 5% |

A weighted score of 0.35 or more is BUY, −0.35 or less is SELL, and anything in between is HOLD.

- **Signal strength (0–100)** shows how strongly the indicators agree. It is **not a probability of profit**.
- **Historical evidence** shows how often past readings with the same signal were profitable N candles later, after 0.30% round-trip costs, on the same 1,000 real candles. It gives a 95% confidence interval and a baseline: how often price rose after any candle. A hit rate near the baseline means the signal added little.

### Backtester

- A signal is read at the **close** of a candle and filled at the **open** of the next one. Tests check that changing future candles never changes earlier trades.
- Every fill pays a fee (0.1% by default) and slippage (5 basis points by default). Trades are long-only spot.
- The last 10–50% of candles is held back and reported separately as **out-of-sample**.
- It warns when there are fewer than 30 trades, when a strategy wins on the training data but loses out-of-sample, or when it trails buy-and-hold.
- The strongest verdict is "Held up in this test". Below 30 trades, the only verdict is "Insufficient trades". Nothing is ever labelled profitable.

### Paper trading

- Orders fill at a live WebSocket price no more than 15 seconds old, or at a fresh REST quote. If neither is available, the order is refused.
- Buys pay `price × (1 + slippage)` and sells receive `price × (1 − slippage)`, with a fee on every fill.
- Each trade stores the market and fill prices, fee, entry price, realised profit and loss, and the price source.

### Forecasts

Each coin and horizon gets a logistic regression on 8 technical features, using closed candles only. History is split in time order into training, tuning and test sets. The tuning set decides how much of the model's lean to keep, so a lean with no evidence behind it collapses to the coin's base rate. Confidence stays Low unless the model beats that base rate on at least 20 independent test periods. Expect most readings to sit near 50%. This is a statistical model, and the app labels it as not AI.

The **Model tracker** saves forecasts while the server runs and scores each one against the real price at its target time. With no outcomes yet, every metric stays empty.

## Safety and data rules

- **Real data only.** Prices, candles, news and events come from named sources. Missing data is shown as missing.
- **Estimates are labelled.** That includes the liquidation heatmap, forecasts, and sentiment from headlines.
- **No real-money trading.** The paper account is the only account, and no exchange keys exist anywhere in the app.
- **Nothing trades on its own.** Every paper order comes from your click. A strategy must be approved, and each of its orders confirmed. Autopilot is never given access to the paper account, and a test checks that.
- **Spot and futures stay apart.** Paper trading only ever uses Binance spot prices.
- **The Arena only shows verified figures.** Backtests are run by the server, and any numbers sent with a request are ignored. Paper results are opt-in and show percentages only. A strategy only earns round trips it opened itself, from a flat position, under its exact published rules.
- **Community text is plain text.** HTML is stripped, comments are rate-limited, and moderation hides content rather than deleting it.
- **Audit trails.** Autopilot logs every run and every settings change. Arena moderation actions are logged.
- **Safe migrations.** `schema.sql` only adds tables and indexes, and never alters or removes existing data.

## Architecture

```
Binance REST and WebSocket ─┐
Other exchanges, RSS feeds, ─┼─► server (Node, Express) ──► /api/*  REST and JSON
calendars, regulators        │    indicators, signal,       /ws     live prices, alerts, order book
PostgreSQL ◄─────────────────┘    backtests, paper trading,
                                  intelligence modules
                                          │
                                          ▼
              client (React, Vite, Tailwind, Lightweight Charts, WebGL)
              /           dashboard
              /lab.html   Intelligence Lab
```

| Path | What it holds |
|---|---|
| `server/src/coins.js` | The coin list |
| `server/src/binance/` | REST client (retries, rate limits, paging) and WebSocket streams (reconnects, stale-price watchdog) |
| `server/src/indicators.js`, `analysis.js` | Indicators and the research signal |
| `server/src/backtest.js`, `paper.js` | Backtester and paper trading |
| `server/src/ai.js` | The only code that calls the Anthropic API |
| `server/src/intel/` | Every Intelligence Lab module, one file each |
| `server/src/schema.sql` | Database tables, applied at every start |
| `client/src/` | The dashboard |
| `client/src/components/lab/` | The Intelligence Lab tabs |
| `scripts/ui_regression.py` | Checks the dashboard against its approved design |

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## API

All endpoints are under `/api`. Use `?symbol=BTCUSDT` style parameters, where a route takes them.

| Area | Endpoints |
|---|---|
| Market data | `GET /health`, `/meta`, `/tickers`, `/overview`, `/candles`, `/analysis` · `POST /analysis/explain` |
| Backtests | `POST /backtest` · `GET /backtests` · `POST /lab/compare`, `/lab/walkforward` |
| Paper trading | `GET /paper/portfolio`, `/paper/trades`, `/paper/equity` · `POST /paper/order`, `/paper/reset` |
| Forecasts and analysis | `GET /forecast`, `/forecast/performance`, `/intel/status`, `/intel/brief` · `POST /intel/chat` |
| Alerts | `GET, POST /alerts/rules` · `PATCH, DELETE /alerts/rules/:id` · `GET /alerts/events` · `POST /alerts/events/read` |
| Portfolio, activity, news | `GET /portfolio/intel`, `/activity`, `/news` · `POST /news/digest` |
| Order book and futures | `GET /orderbook`, `/orderbook/history`, `/futures/overview`, `/futures/detail` |
| Liquidations and exchanges | `GET /liquidations/map`, `/liquidations/events`, `/exchanges/config` · `POST /exchanges/compare` |
| Calendar | `GET /calendar` · `POST /calendar/:id/explain` |
| Reports | `GET /reports`, `/reports/:id`, `/reports/:id/pdf` · `POST /reports/generate` |
| Strategies | `GET, POST /strategies` · `GET /strategies/schema` · `POST /strategies/parse`, `/validate`, `/backtest` · `PUT, DELETE /strategies/:id` · `POST /strategies/:id/approve`, `/:id/backtest`, `/:id/paper-order` · `GET /strategies/:id/check` |
| Replay, risk, journal | `GET, POST /replay/sessions` · `GET, DELETE /replay/sessions/:id` · `POST /replay/sessions/:id/step`, `/:id/order` · `POST /risk/simulate` · `GET /journal` · `PUT /journal/trades/:id/annotation` · `POST /journal/review` |
| Autopilot | `GET, PUT /autopilot/settings` · `POST /autopilot/pause`, `/resume`, `/run` · `GET /autopilot/events`, `/runs`, `/audit` · `POST /autopilot/events/read` |
| Arena | `GET, PUT /arena/me` · `GET /arena/leaderboard` · `POST /arena/publish` · `GET, PATCH /arena/strategies/:id` · `POST /arena/strategies/:id/withdraw`, `/backtest`, `/copy`, `/comments` · `PUT /arena/strategies/:id/rating` · `PUT, DELETE /arena/strategies/:id/favourite` · `GET /arena/profiles/:id` · `PUT, DELETE /arena/profiles/:id/follow` · `POST /arena/reports` · `GET, POST /arena/moderation` · `POST /arena/moderation/reports/:id/dismiss` |

Long lists such as reports and Autopilot findings are paged: pass `before=<id of the last item>`.

## Tests

```bash
npm run test:client     # frontend logic, no database needed
TEST_DATABASE_URL=postgres://signallab:signallab@localhost:5432/signallab_test npm run test:server
```

`TEST_DATABASE_URL` must point to a **separate, disposable** database, because the tests drop and recreate tables. Create one with `createdb signallab_test`, or with `CREATE DATABASE signallab_test;` in psql. Without it, the database tests are skipped.

- **Server: 259 tests.**
  - Indicator maths against reference values, with checks that nothing uses future data.
  - Backtester arithmetic, and the Binance client's retries, rate limits and reconnects.
  - Paper accounting on PostgreSQL, and every Intelligence Lab module.
  - Whole workflows across modules.
  - The API tests run the real app against a local fake Binance (`server/test/support/mock-binance.js`), whose prices exist only for tests.
- **Client: 10 tests.** Price formatting, the coin registry, heatmap filters, and chart and globe maths.

## Protected UI

The dashboard design is locked. Branch `signal-lab-ui-protected` holds the approved version, and new features go in the Intelligence Lab instead. To check the dashboard against that baseline, with the app running:

```bash
python scripts/ui_regression.py
```

It serves the approved code next to the current code, on the same data. It compares structure, styles, positions and page height at desktop and phone widths, and then checks the globe, charts, ticker and navigation. The one approved change since the baseline, the Intelligence Lab button, is allowed by its exact text. The check needs Python with Playwright and Pillow.

## Known limitations

- **No accounts or login.** The app is built for one person on their own computer: one paper account, and one local profile in the Arena. Add authentication, per-user data and moderator roles before putting it on a network.
- **Calendar coverage.** The free weekly feed covers the current week only. Actual values need a FRED key, and crypto-specific events aren't connected.
- **Exchange fees** are editable starting values from public fee schedules, and withdrawal fees have to be entered by hand.
- **Signals, backtests and forecasts describe the past.** Crypto markets change, and a strategy that worked on 1,000 candles can fail on the next 100.
- **Fixed slippage.** Real slippage grows with order size and in thin markets.
- **Simple backtests.** They are long-only, with one position at a time, and leave out funding, taxes and exchange outages.
- **The globe summarises price data.** It doesn't show blockchain transactions, and its connecting arcs are return correlations.
- **Server-side jobs.** Alerts, Autopilot and daily reports only run while the server is running.

## License

[MIT](LICENSE) © 2026 muzammil

---

Not financial advice. Market data © its providers.
