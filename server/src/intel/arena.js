// Community Strategy Arena. Every published figure is computed by this server: submitted numbers are ignored.
// Backtests and verified paper results stay separate, and paper results are shared only with the owner's opt-in.
// This project has no accounts yet, so "me" is one local profile. See docs/ARCHITECTURE.md before hosting it.
import { backtestStrategy, configHash, strategyDescription, validateStrategyConfig } from './strategy.js';

export const CATEGORIES = { trend: 'Trend following', 'mean-reversion': 'Mean reversion', momentum: 'Momentum', breakout: 'Breakout', volatility: 'Volatility', other: 'Other' };
export const MIN_RANKED_TRADES = 30;
const WEIGHTS = { riskAdjusted: 0.25, sharpe: 0.25, drawdown: 0.15, trades: 0.1, duration: 0.15, consistency: 0.1 };
const TARGETS = ['strategy', 'comment', 'profile'];
const COMMENTS_PER_MINUTE = 10;

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Plain text only: tags and control characters go. The page also renders it as text, never as HTML. */
export function cleanText(value, max) {
  let text = String(value ?? '').replace(/[^\P{C}\n]/gu, '');
  // repeated, so a tag hidden inside another (<<b>script>) can't survive. "RSI < 30" isn't a tag and stays.
  for (let before; before !== text;) {
    before = text;
    text = text.replace(/<\/?[a-z!?][^>]*>/gi, '');
  }
  return text.trim().slice(0, max);
}

/** Share of equal time slices that didn't lose money. Needs enough points to mean anything. */
export function consistency(values, slices = 10) {
  if (!values || values.length < slices + 1) return null;
  const size = (values.length - 1) / slices;
  let good = 0;
  for (let i = 0; i < slices; i++) {
    const a = values[Math.round(i * size)], b = values[Math.round((i + 1) * size)];
    if (b >= a) good++;
  }
  return (good / slices) * 100;
}

export function riskRating(config, metrics) {
  let points = 0;
  const reasons = [];
  const dd = metrics?.maxDrawdownPct;
  if (Number.isFinite(dd)) {
    if (dd >= 30) { points += 2; reasons.push(`Backtest drawdown reached ${dd.toFixed(1)}%`); } else if (dd >= 15) { points += 1; reasons.push(`Backtest drawdown reached ${dd.toFixed(1)}%`); }
  } else { points += 1; reasons.push('No drawdown figure is available'); }
  if (!config.stopLossPct) { points += 1; reasons.push('It has no stop loss'); }
  if (config.positionPct > 50) { points += 1; reasons.push(`It uses ${config.positionPct}% of the balance per position`); }
  if (['1m', '5m'].includes(config.interval)) { points += 1; reasons.push('Very short candles mean more trades and more cost'); }
  return { rating: points >= 3 ? 'High' : points >= 1 ? 'Medium' : 'Low', reasons: reasons.length ? reasons : ['Small drawdown, a stop loss and moderate position size'] };
}

/** From verified paper trades only, as percentages. It never reveals amounts, sizes, balances or single trades. */
export function paperMetrics(rows, now = Date.now()) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => new Date(a.trade_time) - new Date(b.trade_time));
  const closed = sorted.filter((r) => r.side === 'SELL' && Number.isFinite(Number(r.return_pct)) && r.return_pct !== null).map((r) => Number(r.return_pct));
  const first = new Date(sorted[0].trade_time).getTime();
  const durationDays = (now - first) / 86400e3;
  let equity = 100, peak = 100, maxDD = 0;
  const curve = [100];
  for (const r of closed) {
    equity *= 1 + r / 100;
    curve.push(equity);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, ((peak - equity) / peak) * 100);
  }
  const mean = closed.length ? closed.reduce((s, v) => s + v, 0) / closed.length : null;
  const sd = closed.length > 1 ? Math.sqrt(closed.reduce((s, v) => s + (v - mean) ** 2, 0) / (closed.length - 1)) : null;
  const perYear = durationDays > 0 ? (closed.length / durationDays) * 365 : 0;
  return {
    completedTrades: closed.length,
    durationDays,
    totalReturnPct: equity - 100,
    maxDrawdownPct: maxDD,
    winRatePct: closed.length ? (closed.filter((v) => v > 0).length / closed.length) * 100 : null,
    avgTradePct: mean,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : null,
    consistencyPct: consistency(curve, 5),
    returnBasis: 'Each closed trade compounded in sequence, as if fully reinvested. Not a return on the account balance.',
  };
}

/**
 * Which paper trades a strategy has fairly earned. A position blends every buy into one average price, so a round trip
 * only counts if the strategy opened it from flat and every order in it came from those exact rules. Otherwise
 * a strategy could inherit gains or losses from a position someone else built.
 * trades: oldest first. hashes: trade id -> rules hash, recorded when the strategy placed the order.
 */
export function creditableTrades(trades, hashes) {
  const DUST = 1e-9;
  const trips = new Map();
  const out = [];
  for (const t of trades) {
    const hash = hashes.get(String(t.id)) ?? null;
    const trip = trips.get(t.symbol) ?? { qty: 0, hash: null, clean: false, start: 0 };
    const qty = Number(t.qty);
    if (t.side === 'BUY') {
      if (trip.qty <= DUST) Object.assign(trip, { qty: 0, hash, clean: Boolean(hash), start: new Date(t.created_at).getTime() });
      else if (hash !== trip.hash) trip.clean = false;
      trip.qty += qty;
    } else {
      if (hash !== trip.hash) trip.clean = false;
      trip.qty -= qty;
    }
    if (trip.clean) out.push({ ...t, hash: trip.hash, tripStart: trip.start });
    if (trip.qty <= DUST) trip.clean = false;
    trips.set(t.symbol, trip);
  }
  return out;
}

const metricView = (basis, row) => {
  if (basis === 'paper') {
    const m = row.paper;
    return m && { trades: m.completedTrades, totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct, sharpe: m.sharpe, consistencyPct: m.consistencyPct, durationDays: m.durationDays };
  }
  const m = row.backtest?.metrics;
  return m && { trades: m.trades, totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct, sharpe: m.sharpe, consistencyPct: row.backtest.consistencyPct, durationDays: null };
};

function percentRanks(items, valueOf) {
  const known = items.map(valueOf).filter(Number.isFinite).sort((a, b) => a - b);
  const rankOf = (v) => {
    if (!Number.isFinite(v)) return null;
    if (known.length === 1) return 0.5;
    const below = known.filter((x) => x < v).length;
    const same = known.filter((x) => x === v).length;
    return (below + (same - 1) / 2) / (known.length - 1);
  };
  return items.map((it) => rankOf(valueOf(it)));
}

/**
 * The score blends measures of risk and reliability, and a high return on its own can't top the table.
 * A criterion with no data for any strategy is left out and the other weights are rescaled.
 * Backtests have no verified duration, so that criterion only applies to paper results.
 */
export function rankStrategies(rows, basis = 'backtest') {
  const entries = rows.map((row) => ({ row, m: metricView(basis, row) }));
  const eligible = entries.filter((e) => e.m && e.m.trades >= MIN_RANKED_TRADES && Number.isFinite(e.m.totalReturnPct) && Number.isFinite(e.m.maxDrawdownPct));
  const parts = {
    riskAdjusted: percentRanks(eligible, (e) => e.m.totalReturnPct / Math.max(e.m.maxDrawdownPct, 1)),
    sharpe: percentRanks(eligible, (e) => e.m.sharpe),
    drawdown: percentRanks(eligible, (e) => -e.m.maxDrawdownPct),
    trades: percentRanks(eligible, (e) => e.m.trades),
    duration: basis === 'paper' ? percentRanks(eligible, (e) => e.m.durationDays) : eligible.map(() => null),
    consistency: percentRanks(eligible, (e) => e.m.consistencyPct),
  };
  const ranked = eligible.map((e, i) => {
    let sum = 0, weight = 0;
    const criteria = {};
    for (const [k, w] of Object.entries(WEIGHTS)) {
      const v = parts[k][i];
      criteria[k] = v === null ? null : Math.round(v * 100);
      if (v !== null) { sum += v * w; weight += w; }
    }
    return { ...e.row, metrics: e.m, score: weight ? Math.round((sum / weight) * 100) : null, criteria };
  }).sort((a, b) => b.score - a.score || a.id - b.id).map((r, i) => ({ ...r, rank: i + 1 }));
  const unranked = entries.filter((e) => !eligible.includes(e)).map((e) => ({
    ...e.row,
    metrics: e.m,
    rank: null,
    score: null,
    reason: !e.m
      ? (basis === 'paper' ? 'No verified paper results shared' : 'No backtest result')
      : `${e.m.trades} completed ${e.m.trades === 1 ? 'trade' : 'trades'}, needs ${MIN_RANKED_TRADES} to be ranked`,
  }));
  return { ranked, unranked };
}

/** Only these fields ever leave the server. Nothing from the paper account is on this list. */
function publicStrategy(s) {
  const bt = s.backtest;
  return {
    id: s.id,
    profile: { id: s.profile_id, handle: s.handle },
    name: s.name,
    description: s.description,
    category: s.category,
    categoryLabel: CATEGORIES[s.category] ?? s.category,
    symbol: s.symbol,
    interval: s.interval,
    riskRating: s.risk_rating,
    riskReasons: s.risk_reasons,
    publishedAt: s.published_at,
    backtest: bt ? { metrics: bt.metrics, outOfSample: bt.outOfSample, verdict: bt.verdict, verdictDetail: bt.detail, consistencyPct: bt.consistencyPct, candlesUsed: bt.candlesUsed, assumptions: bt.assumptions, computedAt: s.backtest_at } : null,
    paper: s.paper ?? null,
    paperShared: Boolean(s.share_paper),
    rating: { average: s.rating_avg === null || s.rating_avg === undefined ? null : Number(s.rating_avg), count: Number(s.rating_count ?? 0) },
    comments: Number(s.comment_count ?? 0),
    isFavourite: Boolean(s.is_favourite),
    mine: Boolean(s.is_mine),
    followingCreator: Boolean(s.following_creator),
  };
}

const SELECT_STRATEGY = `
  SELECT a.*, p.handle,
    (SELECT round(avg(stars)::numeric, 2) FROM arena_ratings r WHERE r.arena_strategy_id=a.id) AS rating_avg,
    (SELECT count(*) FROM arena_ratings r WHERE r.arena_strategy_id=a.id) AS rating_count,
    (SELECT count(*) FROM arena_comments c WHERE c.arena_strategy_id=a.id AND NOT c.hidden) AS comment_count,
    EXISTS (SELECT 1 FROM arena_favourites f WHERE f.arena_strategy_id=a.id AND f.profile_id=$1) AS is_favourite,
    EXISTS (SELECT 1 FROM arena_follows w WHERE w.followee_id=a.profile_id AND w.follower_id=$1) AS following_creator,
    (a.profile_id = $1) AS is_mine
  FROM arena_strategies a JOIN arena_profiles p ON p.id=a.profile_id`;

export function createArena({ pool, markets, historyFor }) {
  const isActive = markets.isActive;

  async function me() {
    const { rows: [p] } = await pool.query('SELECT * FROM arena_profiles WHERE is_local LIMIT 1');
    return p ?? null;
  }
  const needMe = async () => {
    const p = await me();
    if (!p) throw fail(409, 'Create your profile first');
    return p;
  };
  const myId = async () => (await me())?.id ?? null;

  async function saveProfile(body) {
    const handle = String(body?.handle ?? '').trim();
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(handle)) throw fail(400, 'A handle needs 3 to 24 letters, numbers, dashes or underscores');
    const bio = cleanText(body?.bio, 500);
    const current = await me();
    try {
      const { rows: [p] } = current
        ? await pool.query('UPDATE arena_profiles SET handle=$1, bio=$2 WHERE id=$3 RETURNING *', [handle, bio, current.id])
        : await pool.query('INSERT INTO arena_profiles (handle, bio, is_local) VALUES ($1,$2,true) RETURNING *', [handle, bio]);
      return p;
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'That handle is taken');
      throw e;
    }
  }

  /** The server's own backtest of the exact rules being published. No figure comes from the request. */
  async function computeBacktest(config) {
    const candles = await historyFor(config.symbol, config.interval, 2000);
    const r = backtestStrategy(candles, config, { feeRate: 0.001, slippageBps: 5 });
    return {
      metrics: r.metrics, inSample: r.inSample, outOfSample: r.outOfSample,
      verdict: r.verdict, detail: r.detail,
      consistencyPct: consistency((r.equity || []).map((e) => e.value)),
      candlesUsed: r.candlesUsed, assumptions: r.assumptions,
    };
  }

  async function publish(body) {
    const profile = await needMe();
    if (body?.confirmed !== true) throw fail(400, 'Publishing makes these rules public, so it needs your confirmation');
    const { rows: [s] } = await pool.query('SELECT * FROM strategies WHERE id=$1', [Number(body.strategyId)]);
    if (!s) throw fail(404, 'No such strategy');
    if (s.status !== 'approved') throw fail(409, 'Review and approve this strategy before publishing it');
    const checked = validateStrategyConfig(s.config, { isActive });
    if (checked.errors.length) throw fail(400, checked.errors[0]);
    const category = String(body.category ?? '');
    if (!CATEGORIES[category]) throw fail(400, 'Choose a category');
    const description = cleanText(body.description, 2000);
    if (description.length < 10) throw fail(400, 'Add a description of at least 10 characters');
    const config = checked.config;
    const hash = configHash(config);
    const { rows: [existing] } = await pool.query('SELECT id, status FROM arena_strategies WHERE profile_id=$1 AND config_hash=$2', [profile.id, hash]);
    if (existing?.status === 'published') throw fail(409, 'You have already published a strategy with these exact rules');
    const backtest = await computeBacktest(config);
    const risk = riskRating(config, backtest.metrics);
    const sharePaper = body.sharePaper === true;
    const values = [s.id, cleanText(config.name, 80), description, category, config, config.symbol, config.interval, sharePaper, sharePaper ? new Date() : null, risk.rating, JSON.stringify(risk.reasons), backtest];
    const { rows: [row] } = existing
      ? await pool.query(`UPDATE arena_strategies SET strategy_id=$1, name=$2, description=$3, category=$4, config=$5, symbol=$6, interval=$7, share_paper=$8, paper_since=$9, risk_rating=$10, risk_reasons=$11, backtest=$12, backtest_at=now(), status='published', published_at=now() WHERE id=$13 RETURNING id`, [...values, existing.id])
      : await pool.query(`INSERT INTO arena_strategies (strategy_id, name, description, category, config, symbol, interval, share_paper, paper_since, risk_rating, risk_reasons, backtest, backtest_at, profile_id, config_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14) RETURNING id`, [...values, profile.id, hash]);
    return detail(row.id);
  }

  /**
   * Copies trades into the verified record once the owner has opted in. It reads the paper tables and doesn't change
   * them. The trade id is the key, so a trade counts once and only once.
   */
  async function capturePaper() {
    const { rows: shared } = await pool.query(`SELECT id, config_hash, paper_since FROM arena_strategies WHERE share_paper AND status='published' AND paper_since IS NOT NULL`);
    if (!shared.length) return;
    const [{ rows: trades }, { rows: orders }] = await Promise.all([
      pool.query('SELECT id, symbol, side, qty, entry_price, realized_pnl, created_at FROM paper_trades ORDER BY created_at, id'),
      pool.query('SELECT trade_id, config_hash FROM strategy_orders'),
    ]);
    const hashes = new Map(orders.map((o) => [String(o.trade_id), o.config_hash]));
    for (const t of creditableTrades(trades, hashes)) {
      const a = shared.find((s) => s.config_hash === t.hash && t.tripStart >= new Date(s.paper_since).getTime());
      if (!a) continue;
      const qty = Number(t.qty), entry = Number(t.entry_price);
      const ret = t.side === 'SELL' && entry > 0 && qty > 0 ? (Number(t.realized_pnl) / (entry * qty)) * 100 : null;
      await pool.query(
        'INSERT INTO arena_verified_trades (trade_id, arena_strategy_id, side, return_pct, trade_time) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (trade_id) DO NOTHING',
        [t.id, a.id, t.side, ret, t.created_at]);
    }
  }

  async function withPaper(rows) {
    const shared = rows.filter((r) => r.share_paper);
    if (!shared.length) return rows;
    await capturePaper();
    const { rows: trades } = await pool.query('SELECT arena_strategy_id, side, return_pct, trade_time FROM arena_verified_trades WHERE arena_strategy_id = ANY($1)', [shared.map((r) => r.id)]);
    return rows.map((r) => (r.share_paper ? { ...r, paper: paperMetrics(trades.filter((t) => String(t.arena_strategy_id) === String(r.id))) } : r));
  }

  async function leaderboard({ basis = 'backtest', category, risk, symbol, filter } = {}) {
    if (!['backtest', 'paper'].includes(basis)) throw fail(400, 'Choose backtest or paper');
    const viewer = await myId();
    const { rows } = await pool.query(
      `${SELECT_STRATEGY} WHERE a.status='published' AND NOT a.hidden AND NOT p.hidden
       AND ($2::text IS NULL OR a.category=$2) AND ($3::text IS NULL OR a.risk_rating=$3) AND ($4::text IS NULL OR a.symbol=$4)
       AND ($5::text IS NULL
         OR ($5='favourites' AND EXISTS (SELECT 1 FROM arena_favourites f WHERE f.arena_strategy_id=a.id AND f.profile_id=$1))
         OR ($5='following' AND EXISTS (SELECT 1 FROM arena_follows w WHERE w.followee_id=a.profile_id AND w.follower_id=$1)))
       ORDER BY a.id LIMIT 500`,
      [viewer, category || null, risk || null, symbol || null, ['favourites', 'following'].includes(filter) ? filter : null]);
    const withStats = (await withPaper(rows)).map(publicStrategy);
    return { basis, ...rankStrategies(withStats, basis), minimumTrades: MIN_RANKED_TRADES, weights: WEIGHTS };
  }

  async function detail(id) {
    const num = Number(id);
    if (!Number.isInteger(num)) throw fail(404, 'No such strategy');
    const viewer = await myId();
    const { rows: [row] } = await pool.query(`${SELECT_STRATEGY} WHERE a.id=$2`, [viewer, num]);
    const owner = row && String(row.profile_id) === String(viewer);
    if (!row || (!owner && (row.status !== 'published' || row.hidden))) throw fail(404, 'No such strategy');
    const [withStats] = await withPaper([row]);
    const { rows: comments } = await pool.query(
      `SELECT c.id, c.body, c.created_at, c.profile_id, p.handle FROM arena_comments c JOIN arena_profiles p ON p.id=c.profile_id
       WHERE c.arena_strategy_id=$1 AND NOT c.hidden AND NOT p.hidden ORDER BY c.id DESC LIMIT 200`, [num]);
    const { rows: [mine] } = await pool.query('SELECT stars FROM arena_ratings WHERE arena_strategy_id=$1 AND profile_id=$2', [num, viewer]);
    return { ...publicStrategy(withStats), status: row.status, rules: strategyDescription(row.config), config: row.config, comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, profile: { id: c.profile_id, handle: c.handle } })), myRating: mine?.stars ?? null };
  }

  const requirePublished = async (id) => {
    const { rows: [s] } = await pool.query(`SELECT * FROM arena_strategies WHERE id=$1 AND status='published' AND NOT hidden`, [Number(id)]);
    if (!s) throw fail(404, 'No such strategy');
    return s;
  };
  const requireMine = async (id) => {
    const profile = await needMe();
    const { rows: [s] } = await pool.query('SELECT * FROM arena_strategies WHERE id=$1 AND profile_id=$2', [Number(id), profile.id]);
    if (!s) throw fail(404, 'You can only change your own strategies');
    return s;
  };

  async function update(id, body) {
    const s = await requireMine(id);
    const description = body?.description === undefined ? s.description : cleanText(body.description, 2000);
    if (description.length < 10) throw fail(400, 'Add a description of at least 10 characters');
    const category = body?.category === undefined ? s.category : String(body.category);
    if (!CATEGORIES[category]) throw fail(400, 'Choose a category');
    const share = body?.sharePaper === undefined ? s.share_paper : body.sharePaper === true;
    // turning sharing off removes the copied record, and turning it on counts only trades from then on
    if (s.share_paper && !share) await pool.query('DELETE FROM arena_verified_trades WHERE arena_strategy_id=$1', [s.id]);
    const since = share ? (s.share_paper ? s.paper_since : new Date()) : null;
    await pool.query('UPDATE arena_strategies SET description=$1, category=$2, share_paper=$3, paper_since=$4 WHERE id=$5', [description, category, share, since, s.id]);
    return detail(s.id);
  }

  async function withdraw(id) {
    const s = await requireMine(id);
    await pool.query(`UPDATE arena_strategies SET status='withdrawn' WHERE id=$1`, [s.id]);
    return { ok: true };
  }

  async function rerun(id) {
    const s = await requireMine(id);
    const backtest = await computeBacktest(s.config);
    const risk = riskRating(s.config, backtest.metrics);
    await pool.query('UPDATE arena_strategies SET backtest=$1, backtest_at=now(), risk_rating=$2, risk_reasons=$3 WHERE id=$4', [backtest, risk.rating, JSON.stringify(risk.reasons), s.id]);
    return detail(s.id);
  }

  /** Copies the rules into the Strategy Builder as an unapproved draft, so they get reviewed before any use. */
  async function copy(id) {
    const s = await requirePublished(id);
    const checked = validateStrategyConfig(s.config, { isActive });
    if (checked.errors.length) throw fail(400, checked.errors[0]);
    const { rows: [row] } = await pool.query(`INSERT INTO strategies (name, config, source_mode) VALUES ($1,$2,'arena') RETURNING id, name, status`, [`Copy of ${s.name}`.slice(0, 80), { ...checked.config, name: `Copy of ${s.name}`.slice(0, 80) }]);
    return row;
  }

  async function addComment(id, body) {
    const profile = await needMe();
    await requirePublished(id);
    const text = cleanText(body?.body, 1000);
    if (text.length < 2) throw fail(400, 'Write a comment first');
    const { rows: [recent] } = await pool.query(`SELECT count(*)::int n FROM arena_comments WHERE profile_id=$1 AND created_at > now() - interval '1 minute'`, [profile.id]);
    if (recent.n >= COMMENTS_PER_MINUTE) throw fail(429, 'Too many comments. Try again in a minute.');
    const { rows: [dup] } = await pool.query('SELECT 1 FROM arena_comments WHERE profile_id=$1 AND arena_strategy_id=$2 AND body=$3 LIMIT 1', [profile.id, Number(id), text]);
    if (dup) throw fail(409, 'You already posted that comment');
    await pool.query('INSERT INTO arena_comments (arena_strategy_id, profile_id, body) VALUES ($1,$2,$3)', [Number(id), profile.id, text]);
    return detail(id);
  }

  async function rate(id, body) {
    const profile = await needMe();
    const s = await requirePublished(id);
    if (String(s.profile_id) === String(profile.id)) throw fail(409, "You can't rate your own strategy");
    const stars = Number(body?.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw fail(400, 'A rating is 1 to 5 stars');
    await pool.query('INSERT INTO arena_ratings (arena_strategy_id, profile_id, stars) VALUES ($1,$2,$3) ON CONFLICT (arena_strategy_id, profile_id) DO UPDATE SET stars=$3', [s.id, profile.id, stars]);
    return detail(id);
  }

  async function setFavourite(id, on) {
    const profile = await needMe();
    const s = await requirePublished(id);
    if (on) await pool.query('INSERT INTO arena_favourites (arena_strategy_id, profile_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [s.id, profile.id]);
    else await pool.query('DELETE FROM arena_favourites WHERE arena_strategy_id=$1 AND profile_id=$2', [s.id, profile.id]);
    return { favourite: on };
  }

  async function setFollow(profileId, on) {
    const profile = await needMe();
    const { rows: [target] } = await pool.query('SELECT id FROM arena_profiles WHERE id=$1 AND NOT hidden', [Number(profileId)]);
    if (!target) throw fail(404, 'No such profile');
    if (String(target.id) === String(profile.id)) throw fail(409, "You can't follow yourself");
    if (on) await pool.query('INSERT INTO arena_follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [profile.id, target.id]);
    else await pool.query('DELETE FROM arena_follows WHERE follower_id=$1 AND followee_id=$2', [profile.id, target.id]);
    return { following: on };
  }

  async function publicProfile(id) {
    const num = Number(id);
    if (!Number.isInteger(num)) throw fail(404, 'No such profile');
    const { rows: [p] } = await pool.query('SELECT id, handle, bio, created_at FROM arena_profiles WHERE id=$1 AND NOT hidden', [num]);
    if (!p) throw fail(404, 'No such profile');
    const viewer = await myId();
    const { rows: [counts] } = await pool.query(`SELECT (SELECT count(*)::int FROM arena_follows WHERE followee_id=$1) followers, (SELECT count(*)::int FROM arena_follows WHERE follower_id=$1) following, EXISTS (SELECT 1 FROM arena_follows WHERE followee_id=$1 AND follower_id=$2) AS is_following`, [num, viewer]);
    const { rows } = await pool.query(`${SELECT_STRATEGY} WHERE a.profile_id=$2 AND a.status='published' AND NOT a.hidden ORDER BY a.id DESC LIMIT 100`, [viewer, num]);
    return { id: p.id, handle: p.handle, bio: p.bio, joined: p.created_at, followers: counts.followers, following: counts.following, isFollowing: counts.is_following, mine: String(p.id) === String(viewer), strategies: (await withPaper(rows)).map(publicStrategy) };
  }

  async function myStrategies() {
    const viewer = await myId();
    if (!viewer) return [];
    const { rows } = await pool.query(`${SELECT_STRATEGY} WHERE a.profile_id=$1 ORDER BY a.id DESC`, [viewer]);
    return (await withPaper(rows)).map((r) => ({ ...publicStrategy(r), status: r.status, hidden: r.hidden }));
  }

  // ---- moderation
  const targetExists = async (type, id) => {
    const table = { strategy: 'arena_strategies', comment: 'arena_comments', profile: 'arena_profiles' }[type];
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]);
    return rows.length > 0;
  };

  async function report(body) {
    const profile = await needMe();
    const type = String(body?.targetType ?? '');
    const id = Number(body?.targetId);
    if (!TARGETS.includes(type) || !Number.isInteger(id)) throw fail(400, 'Choose what to report');
    const reason = cleanText(body?.reason, 500);
    if (reason.length < 5) throw fail(400, 'Say what is wrong in at least 5 characters');
    if (!(await targetExists(type, id))) throw fail(404, 'Nothing to report there');
    const { rows } = await pool.query(
      `INSERT INTO arena_reports (reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING RETURNING id`,
      [profile.id, type, id, reason]);
    if (!rows.length) throw fail(409, 'You have already reported this');
    return { ok: true, id: rows[0].id };
  }

  async function moderationQueue() {
    const { rows: reports } = await pool.query(`SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, p.handle AS reporter FROM arena_reports r JOIN arena_profiles p ON p.id=r.reporter_id ORDER BY r.status='open' DESC, r.id DESC LIMIT 100`);
    const { rows: log } = await pool.query('SELECT id, at, target_type, target_id, action, reason FROM arena_moderation_log ORDER BY id DESC LIMIT 50');
    return { reports, log };
  }

  /** Hides or restores content. Nothing is deleted, and each action goes in the log. */
  async function moderate(body) {
    const type = String(body?.targetType ?? '');
    const id = Number(body?.targetId);
    if (!TARGETS.includes(type) || !Number.isInteger(id)) throw fail(400, 'Choose what to moderate');
    if (!(await targetExists(type, id))) throw fail(404, 'Nothing there');
    const hidden = body?.hidden === true;
    const table = { strategy: 'arena_strategies', comment: 'arena_comments', profile: 'arena_profiles' }[type];
    await pool.query(`UPDATE ${table} SET hidden=$1 WHERE id=$2`, [hidden, id]);
    await pool.query('INSERT INTO arena_moderation_log (target_type, target_id, action, reason) VALUES ($1,$2,$3,$4)', [type, id, hidden ? 'hidden' : 'restored', cleanText(body?.reason, 500)]);
    await pool.query(`UPDATE arena_reports SET status='resolved' WHERE target_type=$1 AND target_id=$2`, [type, id]);
    return { ok: true, hidden };
  }

  async function dismissReport(id) {
    const { rows } = await pool.query(`UPDATE arena_reports SET status='dismissed' WHERE id=$1 RETURNING id`, [Number(id)]);
    if (!rows.length) throw fail(404, 'No such report');
    return { ok: true };
  }

  return { me, saveProfile, publish, leaderboard, detail, update, withdraw, rerun, copy, addComment, rate, setFavourite, setFollow, publicProfile, myStrategies, report, moderationQueue, moderate, dismissReport, capturePaper };
}

export function attachArena(app, { pool, markets, historyFor, wrap, sym }) {
  const arena = createArena({ pool, markets, historyFor });
  const notice = 'This Arena is local to this server, and there are no user accounts yet. Your profile, strategies and ratings are stored here and nobody else can see them until the app is hosted with accounts.';

  app.get('/api/arena/me', wrap(async (_req, res) => {
    const p = await arena.me();
    res.json({ profile: p && { id: p.id, handle: p.handle, bio: p.bio }, strategies: await arena.myStrategies(), notice, categories: CATEGORIES });
  }));
  app.put('/api/arena/me', wrap(async (req, res) => { const p = await arena.saveProfile(req.body); res.json({ id: p.id, handle: p.handle, bio: p.bio }); }));
  app.get('/api/arena/leaderboard', wrap(async (req, res) => {
    const { basis, category, risk, filter } = req.query;
    res.json(await arena.leaderboard({ basis, category, risk, filter, symbol: req.query.symbol ? sym(req.query.symbol) : null }));
  }));
  app.post('/api/arena/publish', wrap(async (req, res) => res.json(await arena.publish(req.body))));
  app.get('/api/arena/strategies/:id', wrap(async (req, res) => res.json(await arena.detail(req.params.id))));
  app.patch('/api/arena/strategies/:id', wrap(async (req, res) => res.json(await arena.update(req.params.id, req.body))));
  app.post('/api/arena/strategies/:id/withdraw', wrap(async (req, res) => res.json(await arena.withdraw(req.params.id))));
  app.post('/api/arena/strategies/:id/backtest', wrap(async (req, res) => res.json(await arena.rerun(req.params.id))));
  app.post('/api/arena/strategies/:id/copy', wrap(async (req, res) => res.json(await arena.copy(req.params.id))));
  app.post('/api/arena/strategies/:id/comments', wrap(async (req, res) => res.json(await arena.addComment(req.params.id, req.body))));
  app.put('/api/arena/strategies/:id/rating', wrap(async (req, res) => res.json(await arena.rate(req.params.id, req.body))));
  app.put('/api/arena/strategies/:id/favourite', wrap(async (req, res) => res.json(await arena.setFavourite(req.params.id, true))));
  app.delete('/api/arena/strategies/:id/favourite', wrap(async (req, res) => res.json(await arena.setFavourite(req.params.id, false))));
  app.get('/api/arena/profiles/:id', wrap(async (req, res) => res.json(await arena.publicProfile(req.params.id))));
  app.put('/api/arena/profiles/:id/follow', wrap(async (req, res) => res.json(await arena.setFollow(req.params.id, true))));
  app.delete('/api/arena/profiles/:id/follow', wrap(async (req, res) => res.json(await arena.setFollow(req.params.id, false))));
  app.post('/api/arena/reports', wrap(async (req, res) => res.json(await arena.report(req.body))));
  app.get('/api/arena/moderation', wrap(async (_req, res) => res.json(await arena.moderationQueue())));
  app.post('/api/arena/moderation', wrap(async (req, res) => res.json(await arena.moderate(req.body))));
  app.post('/api/arena/moderation/reports/:id/dismiss', wrap(async (req, res) => res.json(await arena.dismissReport(req.params.id))));
  return arena;
}
