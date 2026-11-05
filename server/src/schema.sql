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

CREATE TABLE IF NOT EXISTS calendar_events (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,
  country       TEXT,
  currency      TEXT,
  importance    TEXT NOT NULL,
  event_date    DATE NOT NULL,
  starts_at     TIMESTAMPTZ,
  previous      TEXT,
  forecast      TEXT,
  actual        TEXT,
  actual_source TEXT,
  source_url    TEXT NOT NULL,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS calendar_events_date_idx ON calendar_events(event_date);

CREATE TABLE IF NOT EXISTS research_reports (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('daily','coin')),
  symbol       TEXT,
  report_date  DATE NOT NULL,
  title        TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content      JSONB NOT NULL,
  ai_summary   TEXT,
  ai_model     TEXT
);
CREATE INDEX IF NOT EXISTS research_reports_date_idx ON research_reports(report_date, kind);

CREATE TABLE IF NOT EXISTS autopilot_settings (
  id          INT PRIMARY KEY CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT false,
  paused      BOOLEAN NOT NULL DEFAULT false,
  notify      BOOLEAN NOT NULL DEFAULT true,
  symbols     TEXT[] NOT NULL,
  intervals   TEXT[] NOT NULL,
  conditions  JSONB NOT NULL,
  quiet_start TEXT,
  quiet_end   TEXT,
  quiet_tz    TEXT NOT NULL DEFAULT 'UTC',
  state       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS autopilot_runs (
  id               BIGSERIAL PRIMARY KEY,
  trigger          TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'running',
  steps            JSONB NOT NULL DEFAULT '[]',
  errors           JSONB NOT NULL DEFAULT '[]',
  summary          TEXT,
  pairs_checked    INT NOT NULL DEFAULT 0,
  events_new       INT NOT NULL DEFAULT 0,
  events_duplicate INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS autopilot_events (
  id               BIGSERIAL PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,
  run_id           BIGINT,
  symbol           TEXT NOT NULL,
  interval         TEXT NOT NULL,
  condition        TEXT NOT NULL,
  side             TEXT,
  message          TEXT NOT NULL,
  evidence         JSONB NOT NULL DEFAULT '{}',
  context          JSONB NOT NULL DEFAULT '{}',
  explanation      TEXT,
  explanation_mode TEXT,
  as_of            TIMESTAMPTZ NOT NULL,
  notified         BOOLEAN NOT NULL DEFAULT false,
  suppressed_quiet BOOLEAN NOT NULL DEFAULT false,
  read             BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autopilot_events_created_idx ON autopilot_events(created_at);

CREATE TABLE IF NOT EXISTS autopilot_audit (
  id     BIGSERIAL PRIMARY KEY,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'
);

-- written only at the moment an approved strategy places a paper order, so it can't be attached later
CREATE TABLE IF NOT EXISTS strategy_orders (
  trade_id    BIGINT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  config_hash TEXT NOT NULL,
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arena_profiles (
  id         BIGSERIAL PRIMARY KEY,
  handle     TEXT NOT NULL,
  bio        TEXT NOT NULL DEFAULT '',
  is_local   BOOLEAN NOT NULL DEFAULT false,
  hidden     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS arena_profiles_handle_idx ON arena_profiles (lower(handle));
CREATE UNIQUE INDEX IF NOT EXISTS arena_profiles_local_idx ON arena_profiles (is_local) WHERE is_local;

CREATE TABLE IF NOT EXISTS arena_strategies (
  id           BIGSERIAL PRIMARY KEY,
  profile_id   BIGINT NOT NULL REFERENCES arena_profiles(id),
  strategy_id  BIGINT REFERENCES strategies(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  config       JSONB NOT NULL,
  config_hash  TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  interval     TEXT NOT NULL,
  share_paper  BOOLEAN NOT NULL DEFAULT false,
  paper_since  TIMESTAMPTZ,
  risk_rating  TEXT NOT NULL,
  risk_reasons JSONB NOT NULL DEFAULT '[]',
  backtest     JSONB,
  backtest_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','withdrawn')),
  hidden       BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, config_hash)
);

CREATE TABLE IF NOT EXISTS arena_verified_trades (
  trade_id          BIGINT PRIMARY KEY,
  arena_strategy_id BIGINT NOT NULL REFERENCES arena_strategies(id) ON DELETE CASCADE,
  side              TEXT NOT NULL,
  return_pct        DOUBLE PRECISION,
  trade_time        TIMESTAMPTZ NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arena_comments (
  id                BIGSERIAL PRIMARY KEY,
  arena_strategy_id BIGINT NOT NULL REFERENCES arena_strategies(id) ON DELETE CASCADE,
  profile_id        BIGINT NOT NULL REFERENCES arena_profiles(id),
  body              TEXT NOT NULL,
  hidden            BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arena_ratings (
  arena_strategy_id BIGINT NOT NULL REFERENCES arena_strategies(id) ON DELETE CASCADE,
  profile_id        BIGINT NOT NULL REFERENCES arena_profiles(id),
  stars             INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (arena_strategy_id, profile_id)
);

CREATE TABLE IF NOT EXISTS arena_follows (
  follower_id BIGINT NOT NULL REFERENCES arena_profiles(id),
  followee_id BIGINT NOT NULL REFERENCES arena_profiles(id),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE TABLE IF NOT EXISTS arena_favourites (
  arena_strategy_id BIGINT NOT NULL REFERENCES arena_strategies(id) ON DELETE CASCADE,
  profile_id        BIGINT NOT NULL REFERENCES arena_profiles(id),
  PRIMARY KEY (arena_strategy_id, profile_id)
);

CREATE TABLE IF NOT EXISTS arena_reports (
  id          BIGSERIAL PRIMARY KEY,
  reporter_id BIGINT NOT NULL REFERENCES arena_profiles(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('strategy','comment','profile')),
  target_id   BIGINT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS arena_moderation_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_type TEXT NOT NULL,
  target_id   BIGINT NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS arena_strategies_board_idx ON arena_strategies(status, hidden);
CREATE INDEX IF NOT EXISTS arena_comments_strategy_idx ON arena_comments(arena_strategy_id, id);
CREATE INDEX IF NOT EXISTS arena_comments_recent_idx ON arena_comments(profile_id, created_at);
CREATE INDEX IF NOT EXISTS arena_verified_strategy_idx ON arena_verified_trades(arena_strategy_id);
CREATE INDEX IF NOT EXISTS research_reports_generated_idx ON research_reports(generated_at DESC);
CREATE INDEX IF NOT EXISTS autopilot_runs_purge_idx ON autopilot_runs(started_at) WHERE events_new = 0;

INSERT INTO paper_accounts (id, name) VALUES (1, 'Default') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('paper_accounts','id'), GREATEST(1, (SELECT MAX(id) FROM paper_accounts)));
