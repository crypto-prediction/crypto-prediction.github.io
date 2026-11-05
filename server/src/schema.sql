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

INSERT INTO paper_accounts (id, name) VALUES (1, 'Default') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('paper_accounts','id'), GREATEST(1, (SELECT MAX(id) FROM paper_accounts)));
