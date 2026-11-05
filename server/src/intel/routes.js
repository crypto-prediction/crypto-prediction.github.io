// HTTP routes and background jobs for the intelligence features. Existing routes are untouched.
import { INTERVALS } from '../config.js';
import { aiComplete, aiEnabled, aiStatus } from '../ai.js';
import { forecast, HORIZONS, MODEL_ID } from './forecast.js';
import { createTracker } from './tracker.js';
import { CHAT_SYSTEM, marketBrief, ruleBasedAnswer } from './intelligence.js';
import { ALERT_TYPES, createAlerts, CUSTOM_METRICS, validateRule } from './alerts.js';
import { analyzePortfolio } from './portfolio.js';
import { createActivity } from './activity.js';
import { createNews, DIGEST_SYSTEM, headlinesForDigest } from './news.js';
import { createLab, MAX_COMBINATIONS, MIN_TRADES } from './lab.js';
import { attachResearch } from './routes-research.js';
import { attachMarkets } from './routes-markets.js';
import { attachAutomation } from './routes-automation.js';
import { attachArena } from './arena.js';

const TRACK_EVERY_MS = 5 * 60e3;
const ALERT_EVERY_MS = 30e3;

export function attachIntel(app, ctx) {
  const { pool, stream, markets, paper, lookup, cached, wrap, sym, historyFor, overviewFor, tickersNow, iv } = ctx;

  // ---- forecasts: refit at most once a minute per coin and horizon, and less often on long histories
  const forecastFor = (symbol, horizon) => {
    const spec = HORIZONS[horizon];
    if (!spec) return Promise.reject(Object.assign(new Error(`Unknown horizon ${horizon}`), { status: 400 }));
    // long-history models change slowly and are the expensive ones, so they refit less often
    return cached(`fc:${symbol}:${horizon}`, spec.history > 1000 ? 5 * 60e3 : 60e3, async () => (
      { symbol, ...forecast(await historyFor(symbol, spec.interval, spec.history), horizon, { livePrice: stream?.livePrice(symbol)?.price ?? null }) }
    ));
  };
  const tracker = createTracker({ pool, rest: ctx.rest, markets, forecastFor });
  const alerts = createAlerts({ pool, markets, historyFor, tickersNow, forecastFor });
  const activity = createActivity({ rest: ctx.rest, cached, overviewFor, historyFor, markets, fetchImpl: ctx.fetchImpl });
  const news = createNews({ cached, fetchImpl: ctx.fetchImpl });
  const lab = createLab({ historyFor, isActive: markets.isActive, intervals: INTERVALS });

  const tickerMap = async () => Object.fromEntries((await tickersNow()).tickers.map((t) => [t.symbol, t]));
  const briefNow = () => cached('brief', 30000, async () => {
    const [h1, h4, d1, tickers] = await Promise.all([overviewFor('1h'), overviewFor('4h'), overviewFor('1d'), tickerMap()]);
    return { coins: h1, tickers, brief: marketBrief({ coins: h1, tickers, trends: { '1h': h1, '4h': h4, '1d': d1 } }), fetchedAt: Date.now() };
  });

  // ---- status
  app.get('/api/intel/status', wrap(async (_req, res) => {
    res.json({
      forecasting: { model: MODEL_ID, type: 'statistical', running: true, detail: 'Logistic regression on technical indicators. It runs on this server and needs no AI service.' },
      ai: aiStatus(),
      tracker: await tracker.counts(),
      horizons: Object.keys(HORIZONS),
      alertTypes: Object.fromEntries(Object.entries(ALERT_TYPES).map(([k, v]) => [k, { label: v.label, needs: v.needs || [], defaults: v.defaults || {} }])),
      customMetrics: CUSTOM_METRICS,
      lab: { minimumTrades: MIN_TRADES, maxCombinations: MAX_COMBINATIONS },
    });
  }));

  // ---- forecasting
  app.get('/api/forecast', wrap(async (req, res) => {
    const horizon = String(req.query.horizon || '24h');
    if (!HORIZONS[horizon]) return res.status(400).json({ error: `Horizon must be one of ${Object.keys(HORIZONS).join(', ')}` });
    const symbols = req.query.symbol ? [sym(req.query.symbol)] : markets.active();
    const forecasts = await Promise.all(symbols.map(async (s) => {
      try { return await forecastFor(s, horizon); } catch (e) { return { symbol: s, unavailable: e.message }; }
    }));
    res.json({ horizon, fetchedAt: Date.now(), forecasts, disclaimer: 'A statistical estimate from past candles. It is not a guarantee and not financial advice.' });
  }));

  app.get('/api/forecast/performance', wrap(async (_req, res) => {
    res.json({ ...(await tracker.performance()), recent: await tracker.recent() });
  }));

  // ---- market intelligence and chat
  app.get('/api/intel/brief', wrap(async (_req, res) => {
    const { brief, fetchedAt } = await briefNow();
    res.json({ ...brief, fetchedAt, ai: aiStatus() });
  }));

  app.post('/api/intel/chat', wrap(async (req, res) => {
    const question = String(req.body?.question || '').trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: 'Ask a question first' });
    const data = await briefNow();
    const rules = () => ruleBasedAnswer(question, data);
    if (!aiEnabled()) return res.json({ answer: rules(), mode: 'rules', ai: aiStatus(), fetchedAt: data.fetchedAt });
    try {
      const context = { asOf: new Date(data.fetchedAt).toISOString(), brief: data.brief, coins: data.coins, tickers: data.tickers };
      const r = await aiComplete({ system: CHAT_SYSTEM, user: `Market readings (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}`, client: ctx.aiClient });
      return res.json({ answer: r.text, mode: 'ai', model: r.model, ai: aiStatus(), fetchedAt: data.fetchedAt });
    } catch (e) {
      // the AI failing is reported, and the answer that follows is labelled as rule-based
      return res.json({ answer: rules(), mode: 'rules', aiError: e.message, ai: aiStatus(), fetchedAt: data.fetchedAt });
    }
  }));

  // ---- alerts
  app.get('/api/alerts/rules', wrap(async (_req, res) => {
    const { rows } = await pool.query('SELECT id, symbol, type, interval, params, note, cooldown_min, enabled, state, created_at FROM alert_rules ORDER BY id DESC');
    res.json(rows);
  }));
  app.post('/api/alerts/rules', wrap(async (req, res) => {
    const r = validateRule(req.body, markets.isActive);
    const { rows: [row] } = await pool.query(
      'INSERT INTO alert_rules (symbol, type, interval, params, note, cooldown_min) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [r.symbol, r.type, r.interval, r.params, r.note, r.cooldown]);
    res.json(row);
  }));
  app.patch('/api/alerts/rules/:id', wrap(async (req, res) => {
    const { rows: [row] } = await pool.query('UPDATE alert_rules SET enabled=$1 WHERE id=$2 RETURNING *', [Boolean(req.body?.enabled), Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'No such alert' });
    res.json(row);
  }));
  app.delete('/api/alerts/rules/:id', wrap(async (req, res) => {
    await pool.query('DELETE FROM alert_rules WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));
  app.get('/api/alerts/events', wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM alert_events ORDER BY id DESC LIMIT $1', [Math.min(200, Number(req.query.limit) || 100)]);
    const { rows: [u] } = await pool.query('SELECT COUNT(*)::int AS unread FROM alert_events WHERE NOT read');
    res.json({ events: rows, unread: u.unread });
  }));
  app.post('/api/alerts/events/read', wrap(async (_req, res) => {
    await pool.query('UPDATE alert_events SET read=true WHERE NOT read');
    res.json({ ok: true });
  }));

  // ---- portfolio intelligence: read only
  app.get('/api/portfolio/intel', wrap(async (_req, res) => {
    const [pf, equity] = await Promise.all([paper.portfolio(lookup), paper.equityHistory()]);
    const returnsBySymbol = {};
    const failed = [];
    await Promise.all(markets.active().map(async (s) => {
      try {
        const closes = (await historyFor(s, '1h')).filter((c) => c.closed !== false).slice(-201).map((c) => c.close);
        returnsBySymbol[s] = closes.slice(1).map((c, i) => c / closes[i] - 1);
      } catch { failed.push(s); }
    }));
    const ordered = Object.fromEntries(markets.active().filter((s) => returnsBySymbol[s]).map((s) => [s, returnsBySymbol[s]]));
    res.json({ ...analyzePortfolio(pf, equity, ordered, 24), equityCurve: equity, correlationBasis: 'Hourly returns, last 200 candles', failed });
  }));

  // ---- market activity
  app.get('/api/activity', wrap(async (req, res) => res.json(await activity.report(sym(req.query.symbol)))));

  // ---- news
  app.get('/api/news', wrap(async (req, res) => {
    const data = await news.latest();
    const symbol = req.query.symbol ? sym(req.query.symbol) : null;
    res.json({ ...data, articles: symbol ? data.articles.filter((a) => a.coins.includes(symbol)) : data.articles, ai: aiStatus() });
  }));
  app.post('/api/news/digest', wrap(async (req, res) => {
    const data = await news.latest();
    const symbol = req.body?.symbol ? sym(req.body.symbol) : null;
    const headlines = headlinesForDigest(data.articles, symbol);
    if (!headlines) return res.status(404).json({ error: 'No recent headlines to summarise for this coin' });
    const r = await aiComplete({ system: DIGEST_SYSTEM, user: `Headlines:\n${headlines}`, client: ctx.aiClient });
    res.json({ text: r.text, model: r.model, generatedAt: Date.now(), interpretation: true });
  }));

  // ---- backtesting lab
  app.post('/api/lab/compare', wrap(async (req, res) => res.json(await lab.compare(req.body))));
  app.post('/api/lab/walkforward', wrap(async (req, res) => res.json(await lab.walkForward({ ...req.body, interval: iv(req.body?.interval) }))));

  attachResearch(app, ctx);
  const marketTools = attachMarkets(app, ctx);
  const arena = attachArena(app, ctx);
  const automation = attachAutomation(app, ctx, { tracker, news, forecastFor, orderBook: marketTools.orderBook, futures: marketTools.futures, exchanges: marketTools.exchanges, liquidations: marketTools.liquidations });

  /** Background work, started only by the real server. Returns a stop function. */
  function startJobs() {
    const safely = (name, fn) => () => fn().catch((e) => console.warn(`[${name}] ${e.message}`));
    const track = safely('tracker', async () => { await tracker.resolve(); await tracker.record(); });
    const check = safely('alerts', () => alerts.evaluate());
    track();
    const a = setInterval(track, TRACK_EVERY_MS);
    const b = setInterval(check, ALERT_EVERY_MS);
    const stopMarkets = marketTools.startJobs();
    const stopAutomation = automation.startJobs();
    return () => { clearInterval(a); clearInterval(b); stopMarkets(); stopAutomation(); };
  }

  return { alerts, tracker, forecastFor, startJobs, books: marketTools.books, liquidationFeed: marketTools.liquidationFeed, calendar: automation.calendar, reports: automation.reports, autopilot: automation.autopilot, arena };
}
