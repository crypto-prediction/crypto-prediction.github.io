# Signal Lab — crypto research and paper trading

A dashboard for 10 Binance spot pairs (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK, AVAX and LTC, each against USDT) built on **real Binance market data**: live prices over WebSocket, historical candles over REST, technical indicators, a rule-based research signal with historical evidence, a backtester with fees and slippage, and a $10,000 paper-trading account stored in PostgreSQL.

Nothing in the app generates prices. If Binance can't be reached, the UI says so and the paper account refuses orders.

## Quick start

Requirements: Node.js 20.12+ and Docker (or your own PostgreSQL 14+).

```bash
npm run install:all          # installs server/ and client/ dependencies
npm run db                   # starts PostgreSQL in Docker on :5432
cp server/.env.example server/.env
npm run server               # API + WebSocket relay on http://localhost:4000
npm run client               # dashboard on http://localhost:5173
```

The server creates its tables on start (`server/src/schema.sql`). No Binance API key is needed: only public market-data endpoints are used.

**Binance blocked in your region?** If you see an HTTP 451 error, set these in `server/.env`:

```
BINANCE_REST_URL=https://data-api.binance.vision
BINANCE_WS_URL=wss://data-stream.binance.vision
```

**Optional AI explanations:** set `ANTHROPIC_API_KEY` in `server/.env` and run `npm --prefix server install`. Claude then writes a short plain-language explanation of each reading. The signal itself never depends on the model.

## Adding a coin

Add one line to `server/src/coins.js`. The server, stream, API and dashboard all read that list, and the client receives it from `/api/meta`. At startup and every 6 hours the server checks the list against Binance `exchangeInfo`. A pair Binance doesn't list for spot trading is disabled with a visible reason, and the other pairs carry on. If Binance can't be reached, pairs stay enabled and `/api/health` shows them as unverified.

The globe supports up to 32 coins. `SYMBOLS` in `server/.env` can narrow the list or add a pair.

## Architecture

```
Binance REST  ─┐                         ┌─ /api/*  (REST, JSON)
Binance WS ────┼─► server (Express) ─────┤
PostgreSQL ◄───┘   indicators, signal,   └─ /ws     (live tickers + klines)
                   backtester, paper           │
                                               ▼
                                client (React + Vite + Tailwind + Lightweight Charts)
```

| Path | What it does |
|---|---|
| `server/src/coins.js` | The coin list: symbol, name and colour. |
| `server/src/markets.js` | Which configured pairs Binance currently lists. |
| `server/src/binance/rest.js` | Klines, 24h tickers and prices. Retries on 5xx/network errors with backoff, honours `Retry-After` on 429/418 and pauses requests, explains 451, times out after 10s, pages history beyond 1,000 candles. |
| `server/src/binance/stream.js` | Combined `@ticker` and `@kline_<interval>` streams. Reconnects with exponential backoff and a 60s silence watchdog. A price older than 15s counts as stale. |
| `server/src/indicators.js` | RSI 14 (Wilder), MACD 12/26/9, EMA 20/50/200 (SMA-seeded), Bollinger 20/2 (population σ), volume average, relative volume, OBV, taker-buy share, momentum (10-bar rate of change), volatility (20-bar standard deviation of returns). |
| `server/src/analysis.js` | BUY/SELL/HOLD research signal and its historical evidence. |
| `server/src/backtest.js` | Backtester. |
| `server/src/paper.js` | Paper trading, using PostgreSQL transactions. |
| `server/src/app.js` | HTTP routes and the browser WebSocket relay. |
| `client/src` | Dashboard. |

### API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Database, stream and rate-limit status |
| GET | `/api/meta` | Coins (name, colour, availability), intervals, strategies |
| GET | `/api/tickers` | 24h stats: WebSocket when live, REST otherwise |
| GET | `/api/overview?interval=1h` | One row per coin: trend, RSI, MACD, momentum, volatility, signal |
| GET | `/api/candles?symbol=BTCUSDT&interval=1h&limit=500` | Candles plus every indicator, with source and fetch time. `indicators=0` returns candles only |
| GET | `/api/analysis?symbol=…&interval=…&horizon=12` | Signal, components and evidence |
| POST | `/api/analysis/explain` | Optional Claude explanation |
| POST | `/api/backtest` | `{symbol, interval, strategy, params, bars, feePct, slippageBps, outOfSamplePct}` |
| GET | `/api/backtests` | Saved runs |
| GET | `/api/paper/portfolio` · `/trades` · `/equity` | Account state |
| POST | `/api/paper/order` | `{symbol, side: "BUY"\|"SELL", amountUsd \| qty \| closeAll}` |
| POST | `/api/paper/reset` | Back to $10,000 |
| GET | `/api/intel/status` | Forecast model and AI status |
| GET | `/api/forecast?horizon=24h&symbol=…` | Forecasts for `15m`, `1h`, `4h`, `24h` or `7d` |
| GET | `/api/forecast/performance` | Scores of saved forecasts against real outcomes |
| GET | `/api/intel/brief` | Market mood, momentum, unusual activity, risks, multi-timeframe trend |
| POST | `/api/intel/chat` | `{question}`. Claude when available, otherwise labelled rule-based answers |
| GET, POST, PATCH, DELETE | `/api/alerts/rules` | Alert rules |
| GET, POST | `/api/alerts/events` · `/events/read` | Alert history, mark as read |
| GET | `/api/portfolio/intel` | Read-only exposure, risk and correlation |
| GET | `/api/activity?symbol=…` | Order book, unusual volume and sudden moves, kept apart from on-chain data |
| GET | `/api/news?symbol=…` · POST `/api/news/digest` | Publisher news, labelled estimates, optional AI summary |
| POST | `/api/lab/compare` · `/api/lab/walkforward` | Multi-run backtest comparison, walk-forward validation |

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

A weighted score ≥ 0.35 is BUY, ≤ −0.35 is SELL, and anything in between is HOLD.

The dashboard keeps two different things apart:

- **Signal strength (0–100)** is how strongly the indicators agree. It is a description of the current reading, **not a probability of profit**.
- **Historical evidence** asks: on the same 1,000 real candles, how often were past readings with the same signal profitable N bars later, after 0.30% round-trip costs? It shows a 95% Wilson confidence interval and the baseline (how often price rose after any bar). A hit rate near the baseline means the signal added little. It is a past frequency, not a forecast.

### Backtester
- A signal is read at the **close** of bar *i* using only data up to bar *i*, and filled at the **open** of bar *i+1*. Tests check that changing future candles never changes earlier trades.
- Every fill pays the fee (default 0.1%) and slippage (default 5 bps). The trade is long-only spot. A position still open at the end is closed at the last price, with costs, and flagged.
- The candle still forming is always excluded.
- The last 10–50% of candles is held out and reported separately as **out-of-sample**.
- Parameters are range-checked.
- Warnings appear when there are fewer than 30 trades, when a strategy is profitable in-sample but loses out-of-sample, or when it underperforms buy and hold.
- Metrics:
  - total return vs buy and hold
  - win rate
  - profit factor
  - max drawdown
  - trades
  - exposure
  - annualised Sharpe
  - fees paid
- Every run is stored in `backtest_runs` with its data range and source.

### Paper trading
- **Fill price:** a live WebSocket price (≤ 15s old). If none is available, a fresh REST quote is fetched. If that fails too, the order is refused.
- **Costs:** buys pay `price × (1 + slippage)` and sells receive `price × (1 − slippage)`, with the fee charged on every fill.
- **What each trade stores:**
  - market price and fill price
  - fee
  - entry price
  - realised P&L (after entry and exit fees)
  - price source and its timestamp
- **Unpriceable positions:** if a position can't be priced live, equity is shown as unknown instead of guessed.
- **Separation from real money:** the `mode` column is constrained to `'paper'`, and no exchange keys exist anywhere in the app.

## Intelligence Lab

A separate page at **http://localhost:5173/lab.html**. The dashboard stays the landing page, and its code is unchanged (see "Protected UI"). Only the open tab fetches anything, and the globe doesn't run on this page, so the Lab adds no GPU load.

| Tab | What it shows | Where the data comes from |
|---|---|---|
| Heatmap | Price, 24h change, volume, volatility and direction, with filters | Binance |
| Forecasts | Direction, probabilities, range, support and resistance, volatility, risk and reasons for 5 horizons | Statistical model on Binance candles |
| Analyst | Market mood, risks, multi-timeframe trend, chat | Binance, plus Claude for chat when available |
| Model tracker | Accuracy, precision, recall, Brier score and calibration of saved forecasts | Real outcomes only |
| Alerts | Rules, custom conditions, history | Checked on the server every 30 seconds |
| Portfolio | Exposure, realised and unrealised P&L, risk, correlation | Paper account (read only) and Binance |
| Activity | Order book, unusual volume, sudden moves, large unconfirmed BTC transfers | Binance; blockchain.info for on-chain data |
| Backtest lab | Coins, strategies, timeframes and periods compared; walk-forward validation | Binance history |
| News | Latest articles with coin filters | CoinDesk, Cointelegraph and Decrypt RSS |
| Order book | Live top of book, depth chart, imbalance, large visible orders | Binance spot depth, by REST and WebSocket |
| Futures | Funding, open interest, long/short ratio, basis, kept apart from spot | Binance USD-M perpetuals |
| Liquidations | A modelled heatmap, always labelled as an estimate, beside events Binance actually reported | Binance open interest; Binance forced-order stream |
| Exchanges | Bid, ask, spread, depth, costs and a theoretical difference that is never traded | Public APIs of Binance, Coinbase, Kraken, OKX, Bybit |
| Calendar | Month view, upcoming events, importance, previous and forecast values, source links | ForexFactory weekly export, Federal Reserve, SEC, CFTC |
| Reports | Daily and per-coin reports, archive, date ranges, PDF export | The modules above, with a timestamp and source on each section |
| Strategy builder | Words become validated rules. Review and approval come first. Backtests, and paper orders you confirm | Binance; Claude for parsing when available, otherwise a labelled rule reader |
| Market replay | Step through past candles with simulated orders, optionally with a built strategy | Binance history; the paper account isn't touched |
| Arena | Publish strategies, with backtests and verified paper results ranked apart | Computed by this server |
| Risk simulator | Scenarios, VaR and CVaR on the current portfolio. It writes nothing | Paper account (read only) and Binance |
| Trading journal | Round trips from paper trades, with your notes kept separately | Paper trades (read only) |
| Autopilot | Scheduled research, off by default: conditions, findings, activity and audit logs. It cannot trade | The shared market data, forecast, news and calendar services |

**External services**

| Service | Key needed | Used for |
|---|---|---|
| Binance public data | No | All market data |
| blockchain.info | No | Sample of large unconfirmed Bitcoin transfers |
| CoinDesk, Cointelegraph, Decrypt RSS | No | News |
| Anthropic API | `ANTHROPIC_API_KEY` with credits | Optional: Explain, chat answers, news summaries |
| Binance USD-M futures | No | Futures tab, liquidation data |
| Coinbase, Kraken, OKX, Bybit public APIs | No | Exchanges tab. Fees are editable starting values, and withdrawal fees are entered by you |
| ForexFactory weekly export | No | Calendar. Covers the current week only, with no actual values |
| Federal Reserve, SEC, CFTC | No | FOMC dates and published press releases |
| FRED | `FRED_API_KEY` (free) | Optional: actual US release values in the Calendar |
| Crypto events provider | Not connected | No reliable free source, so upgrades, unlocks and conferences aren't listed |
| On-chain data provider | Not connected | Exchange inflows and outflows and other chains need a paid provider, so they are shown as not connected |

**How the forecast works.** Each coin and horizon gets an L2 logistic regression on 8 technical features, using closed candles only. History is split in time order into training, tuning and test sets. The tuning set decides how much of the model's lean to keep, so a lean with no evidence behind it collapses to the coin's base rate. Confidence stays Low unless the model beats that base rate on at least 20 independent test periods. Expect most readings to sit near 50%. This is a statistics model, and the UI labels it as not AI.

**How the tracker works.** While the server runs, it saves one forecast per coin, horizon and closed candle, then scores each against the real close at its target time. Nothing is estimated: with no outcomes, every metric is empty. Longer horizons take up to 7 days to score, and neighbouring forecasts overlap, so they aren't fully independent.

**Alerts** run on the server, so they keep working with the page closed for as long as the server is running. Anything that fires while you're away appears when you return. There are no phone, email or desktop notifications.

**Autopilot** starts off and only researches. It is never given the paper-trading module, so it has no way to place an order, and a test checks that. A unique key stops the same reading being recorded twice, including after a restart. During quiet hours findings are saved without a notification.

**Reports** save one daily report per UTC day while the server is running, and you can create more by hand. If a source fails, its section says so and the rest of the report carries on. Without AI, the summary is rule-based and labelled that way.

**The Arena is local for now.** This project has no user accounts, so there is one local profile and nobody else can see your strategies. Comments, ratings, follows, reports and moderation all work and are tested, but a real community needs hosting plus accounts, and moderator roles first. Published figures are computed here and submitted numbers are ignored. Paper results are opt-in and show percentages only. A strategy only earns round trips it opened itself from a flat position under the exact published rules, after sharing was turned on.

**Backtest verdicts.** The strongest reading is "Held up in this test". Below 30 trades the only reading is "Insufficient trades". Nothing is ever labelled profitable.

## Protected UI

The dashboard is locked. Branch `signal-lab-ui-protected` holds the approved UI, and it must not be overwritten. New features go on the separate Lab page. To check the dashboard against the baseline after any change, with the app running:

```bash
python scripts/ui_regression.py
```

It serves the protected code next to the current code on the same data, then compares element structure, computed styles, positions, sizes and page height at desktop and mobile widths. It also checks that the protected files match byte for byte, then checks the globe, charts, ticker and navigation. It only reads. It needs Python Playwright and Pillow.

## Tests

```bash
npm run test:client                                           # frontend logic, no database
npm run test:server                                           # server unit tests
TEST_DATABASE_URL=postgres://signallab:signallab@localhost:5432/signallab_test npm run test:server   # + database and API tests
npm test                                                      # both
```

Use a separate, disposable database for `TEST_DATABASE_URL`, because the tests drop and recreate the tables. If port 5432 is taken, use the port your database container is published on.

- **Server (259 tests):** indicators against reference calculations and for no look-ahead; the backtester's arithmetic; the Binance client's retries, rate limits and reconnects; paper accounting on PostgreSQL; `test/pairs.test.js`, which runs candles, indicators, signal, backtest and paper trading for each of the 10 pairs and checks that a delisted pair is refused without affecting the others; and `test/intel.test.js` and `test/intel-api.test.js`, which cover forecasts, tracker scoring, alerts, portfolio analysis, activity, news, the backtest lab and AI status. The API tests run the real app against a local fake Binance (`test/support/mock-binance.js`), whose formula prices exist only for tests.
- **Client (10 tests):** price formatting from BTC down to sub-cent coins, the coin registry, heatmap filters, and the chart and globe maths. There are no component tests in the repository; browser behaviour was checked separately with a scripted browser.

## Limits worth knowing
- Signals and backtests describe the past. Crypto regimes change; a strategy that worked on 1,000 candles can fail on the next 100.
- Slippage is a fixed estimate. Real slippage grows with order size and thin markets.
- Backtests are long-only, with one position at a time, and do not include funding, taxes or exchange outages.
- Times on charts are shown in UTC.
- Forecasts are statistical estimates from past candles. Crypto direction is hard to predict, and most readings carry little or no measured edge.
- The globe summarises price data. It does not show blockchain transactions or money moving between coins; its connecting arcs are return correlations.
- A paper position in a coin that gets delisted can't be priced or closed, so account equity shows as unknown until the account is reset.

Not financial advice.
