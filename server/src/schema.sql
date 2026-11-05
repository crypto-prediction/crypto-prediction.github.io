-- Signal Lab schema. Everything here is PAPER trading; no exchange keys are ever stored.
CREATE TABLE IF NOT EXISTS paper_accounts (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL DEFAULT 'Default',
  mode             TEXT NOT NULL DEFAULT 'paper' CHECK (mode = 'paper'),
  starting_balance NUMERIC(20,8) NOT NULL DEFAULT 10000,
  cash             NUMERIC(20,8) NOT NULL DEFAULT 10000 CHECK (cash >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reset_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_positions (
  account_id  INT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  qty         NUMERIC(30,12) NOT NULL CHECK (qty >= 0),
  avg_price   NUMERIC(20,8) NOT NULL,          -- average fill price, excluding fees
  cost_basis  NUMERIC(20,8) NOT NULL,          -- cash spent including entry fees
  opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id            BIGSERIAL PRIMARY KEY,
  account_id    INT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  qty           NUMERIC(30,12) NOT NULL,
  market_price  NUMERIC(20,8) NOT NULL,        -- Binance price at order time
  fill_price    NUMERIC(20,8) NOT NULL,        -- after slippage
  notional      NUMERIC(20,8) NOT NULL,
  fee           NUMERIC(20,8) NOT NULL,
  slippage_bps  NUMERIC(10,4) NOT NULL,
  entry_price   NUMERIC(20,8),                 -- SELL only: average entry price of the lot sold
  realized_pnl  NUMERIC(20,8),                 -- SELL only: after entry and exit fees
  price_source  TEXT NOT NULL,                 -- 'binance-ws' or 'binance-rest'
  price_time    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_trades_account_idx ON paper_trades(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_equity (
  account_id INT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  equity     NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (account_id, ts)
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  interval    TEXT NOT NULL,
  strategy    TEXT NOT NULL,
  params      JSONB NOT NULL,
  assumptions JSONB NOT NULL,
  metrics     JSONB NOT NULL,
  in_sample   JSONB NOT NULL,
  out_sample  JSONB NOT NULL,
  data_source TEXT NOT NULL,
  data_from   TIMESTAMPTZ NOT NULL,
  data_to     TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added by the intelligence features. These tables are new and never touch the paper tables.
CREATE TABLE IF NOT EXISTS forecasts (
  id              BIGSERIAL PRIMARY KEY,
  symbol          TEXT NOT NULL,
  horizon         TEXT NOT NULL,
  model           TEXT NOT NULL,
  as_of           TIMESTAMPTZ NOT NULL,   -- close of the last candle the forecast could see
  target_time     TIMESTAMPTZ NOT NULL,
  reference_price NUMERIC(24,10) NOT NULL,
  probability_up  DOUBLE PRECISION NOT NULL,
  direction       TEXT NOT NULL,
  range_low       NUMERIC(24,10) NOT NULL,
  range_high      NUMERIC(24,10) NOT NULL,
  regime          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  actual_price    NUMERIC(24,10),
  outcome_up      BOOLEAN,
  in_range        BOOLEAN,
  UNIQUE (symbol, horizon, model, as_of)
);
CREATE INDEX IF NOT EXISTS forecasts_due_idx ON forecasts(target_time) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS alert_rules (
  id           BIGSERIAL PRIMARY KEY,
  symbol       TEXT NOT NULL,
  type         TEXT NOT NULL,
  interval     TEXT NOT NULL DEFAULT '1h',
  params       JSONB NOT NULL DEFAULT '{}',
  note         TEXT,
  cooldown_min INT NOT NULL DEFAULT 60,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  state        JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  id         BIGSERIAL PRIMARY KEY,
  rule_id    BIGINT REFERENCES alert_rules(id) ON DELETE SET NULL,
  symbol     TEXT NOT NULL,
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, dedupe_key)
);

-- Strategy Builder, Market Replay and Trading Journal. New tables only; paper tables are never altered.
CREATE TABLE IF NOT EXISTS strategies (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,
  source_text TEXT,
  source_mode TEXT NOT NULL DEFAULT 'manual',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  approved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_sessions (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  interval      TEXT NOT NULL,
  start_time    TIMESTAMPTZ NOT NULL,
  starting_cash NUMERIC(20,8) NOT NULL,
  cursor_index  INT NOT NULL DEFAULT 0,
  strategy_id   BIGINT REFERENCES strategies(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_trades (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT NOT NULL REFERENCES replay_sessions(id) ON DELETE CASCADE,
  candle_index INT NOT NULL,
  candle_time  TIMESTAMPTZ NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  qty          NUMERIC(30,12) NOT NULL,
  price        NUMERIC(24,10) NOT NULL,
  fee          NUMERIC(20,8) NOT NULL
);
CREATE INDEX IF NOT EXISTS replay_trades_session_idx ON replay_trades(session_id, id);

CREATE TABLE IF NOT EXISTS journal_annotations (
  trade_id     BIGINT PRIMARY KEY,
  entry_reason TEXT,
  exit_reason  TEXT,
  strategy_id  BIGINT REFERENCES strategies(id) ON DELETE SET NULL,
  note         TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Order Book history and Liquidation events.
CREATE TABLE IF NOT EXISTS book_samples (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  mid        DOUBLE PRECISION NOT NULL,
  spread_bps DOUBLE PRECISION NOT NULL,
  bid_usd    DOUBLE PRECISION NOT NULL,
  ask_usd    DOUBLE PRECISION NOT NULL,
  imbalance  DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS book_samples_symbol_ts_idx ON book_samples(symbol, ts);

CREATE TABLE IF NOT EXISTS liquidation_events (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('long','short')),
  price      DOUBLE PRECISION NOT NULL,
  qty        DOUBLE PRECISION NOT NULL,
  usd        DOUBLE PRECISION NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  UNIQUE (symbol, side, price, qty, event_time)
);
CREATE INDEX IF NOT EXISTS liquidation_events_symbol_time_idx ON liquidation_events(symbol, event_time);

INSERT INTO paper_accounts (id, name) VALUES (1, 'Default') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('paper_accounts','id'), GREATEST(1, (SELECT MAX(id) FROM paper_accounts)));
