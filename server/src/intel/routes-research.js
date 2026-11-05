// Routes for Phase 1: Market Replay, Strategy Builder, Risk Simulator and Trading Journal.
import { INTERVALS } from '../config.js';
import { aiComplete, aiEnabled, aiStatus } from '../ai.js';
import { supportResistance } from './forecast.js';
import { createReplay } from './replay.js';
import { createJournal, REVIEW_SYSTEM } from './journal.js';
import { normalizeScenario, simulateRisk } from './risk.js';
import {
  backtestStrategy, buildSeries, INDICATORS, OPERATORS, parseAiDraft, parseStrategyText, strategyDescription, STRATEGY_SYSTEM, strategySignalAt, validateStrategyConfig,
} from './strategy.js';

export function attachResearch(app, ctx) {
  const { pool, rest, markets, paper, lookup, cached, wrap, historyFor } = ctx;
  const replay = createReplay({ pool, rest, markets });
  const journal = createJournal({ pool, rest, cached });
  const validate = (config) => validateStrategyConfig(config, { isActive: markets.isActive });

  // ---- market replay
  app.post('/api/replay/sessions', wrap(async (req, res) => res.json(await replay.create(req.body))));
  app.get('/api/replay/sessions', wrap(async (req, res) => res.json(await replay.list(Number(req.query.limit) || 20))));
  app.get('/api/replay/sessions/:id', wrap(async (req, res) => res.json(await replay.get(req.params.id))));
  app.post('/api/replay/sessions/:id/step', wrap(async (req, res) => res.json(await replay.step(req.params.id, req.body?.count))));
  app.post('/api/replay/sessions/:id/order', wrap(async (req, res) => res.json(await replay.order(req.params.id, req.body))));
  app.delete('/api/replay/sessions/:id', wrap(async (req, res) => { await replay.remove(req.params.id); res.json({ ok: true }); }));

  // ---- strategy builder
  app.get('/api/strategies/schema', (_req, res) => res.json({ indicators: INDICATORS, operators: OPERATORS, intervals: INTERVALS, ai: aiStatus() }));

  app.post('/api/strategies/parse', wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Describe a strategy first' });
    const symbol = req.body?.symbol || null;
    const fromRules = () => parseStrategyText(text, { symbol });
    let aiError = null;
    if (aiEnabled() || ctx.aiClient) {
      try {
        const reply = await aiComplete({ system: STRATEGY_SYSTEM, user: `Strategy description:\n${text.slice(0, 2000)}`, client: ctx.aiClient });
        const raw = parseAiDraft(reply.text);
        const checked = validate({ ...raw, symbol: raw.symbol ?? symbol });
        // the model's output is only ever used after this restricted validation has rebuilt it
        return res.json({ draft: checked.config, mode: 'ai', model: reply.model, warnings: checked.warnings, errors: checked.errors, riskReward: checked.riskReward });
      } catch (e) {
        aiError = e.message;
      }
    }
    const parsed = fromRules();
    const checked = validate(parsed.draft);
    return res.json({ draft: checked.config, mode: 'rules', aiError, warnings: [...parsed.warnings, ...checked.warnings], errors: checked.errors, riskReward: checked.riskReward });
  }));

  app.post('/api/strategies/validate', wrap(async (req, res) => res.json(validate(req.body?.config))));

  const backtest = async (config, body = {}) => {
    const checked = validate(config);
    if (checked.errors.length) throw Object.assign(new Error(checked.errors[0]), { status: 400 });
    const bars = Math.max(300, Math.min(5000, Number(body.bars) || 1000));
    const fee = body.feePct === undefined ? 0.1 : Number(body.feePct);
    const slip = body.slippageBps === undefined ? 5 : Number(body.slippageBps);
    if (!(fee >= 0 && fee <= 1)) throw Object.assign(new Error('Fee must be between 0% and 1%'), { status: 400 });
    if (!(slip >= 0 && slip <= 100)) throw Object.assign(new Error('Slippage must be between 0 and 100 bps'), { status: 400 });
    const candles = await historyFor(checked.config.symbol, checked.config.interval, bars);
    return { symbol: checked.config.symbol, interval: checked.config.interval, ...backtestStrategy(candles, checked.config, { feeRate: fee / 100, slippageBps: slip }) };
  };
  app.post('/api/strategies/backtest', wrap(async (req, res) => res.json(await backtest(req.body?.config, req.body))));

  const getStrategy = async (id) => {
    const { rows: [s] } = await pool.query('SELECT * FROM strategies WHERE id=$1', [Number(id)]);
    if (!s) throw Object.assign(new Error('No such strategy'), { status: 404 });
    return s;
  };
  app.get('/api/strategies', wrap(async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM strategies ORDER BY updated_at DESC LIMIT 200');
    res.json(rows);
  }));
  app.post('/api/strategies', wrap(async (req, res) => {
    const checked = validate(req.body?.config);
    if (checked.errors.length) return res.status(400).json({ error: checked.errors[0], errors: checked.errors });
    const { rows: [row] } = await pool.query(
      'INSERT INTO strategies (name, config, source_text, source_mode) VALUES ($1,$2,$3,$4) RETURNING *',
      [checked.config.name, checked.config, req.body.sourceText ? String(req.body.sourceText).slice(0, 2000) : null, ['ai', 'rules'].includes(req.body.sourceMode) ? req.body.sourceMode : 'manual']);
    res.json(row);
  }));
  app.put('/api/strategies/:id', wrap(async (req, res) => {
    await getStrategy(req.params.id);
    const checked = validate(req.body?.config);
    if (checked.errors.length) return res.status(400).json({ error: checked.errors[0], errors: checked.errors });
    // an edited strategy needs reviewing again
    const { rows: [row] } = await pool.query(`UPDATE strategies SET name=$1, config=$2, status='draft', approved_at=NULL, updated_at=now() WHERE id=$3 RETURNING *`, [checked.config.name, checked.config, Number(req.params.id)]);
    res.json(row);
  }));
  app.delete('/api/strategies/:id', wrap(async (req, res) => {
    await pool.query('DELETE FROM strategies WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  }));
  app.post('/api/strategies/:id/approve', wrap(async (req, res) => {
    const s = await getStrategy(req.params.id);
    const checked = validate(s.config);
    if (checked.errors.length) return res.status(400).json({ error: checked.errors[0], errors: checked.errors });
    const { rows: [row] } = await pool.query(`UPDATE strategies SET status='approved', approved_at=now(), updated_at=now() WHERE id=$1 RETURNING *`, [s.id]);
    res.json(row);
  }));
  app.post('/api/strategies/:id/backtest', wrap(async (req, res) => res.json(await backtest((await getStrategy(req.params.id)).config, req.body))));

  /** What an approved strategy says on the latest closed candle. It reports only and places no order. */
  const checkNow = async (s) => {
    const candles = (await historyFor(s.config.symbol, s.config.interval)).filter((c) => c.closed !== false);
    const series = buildSeries(candles);
    const i = candles.length - 1;
    const pf = await paper.portfolio(lookup);
    const held = pf.positions.find((p) => p.symbol === s.config.symbol);
    return { strategyId: s.id, status: s.status, asOf: candles[i].closeTime, price: candles[i].close, holding: Boolean(held), positionValue: held?.marketValue ?? null, ...strategySignalAt(s.config, series, i, Boolean(held)) };
  };
  app.get('/api/strategies/:id/check', wrap(async (req, res) => res.json(await checkNow(await getStrategy(req.params.id)))));

  /** A paper order from an approved strategy, placed only because the user confirmed this exact order. */
  app.post('/api/strategies/:id/paper-order', wrap(async (req, res) => {
    const s = await getStrategy(req.params.id);
    if (s.status !== 'approved') return res.status(409).json({ error: 'Approve this strategy before paper trading it' });
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'A paper order needs your confirmation' });
    const side = String(req.body.side || '').toUpperCase();
    const trade = await paper.order({ symbol: s.config.symbol, side, amountUsd: req.body.amountUsd, closeAll: Boolean(req.body.closeAll) });
    const d = strategyDescription(s.config);
    await pool.query(
      `INSERT INTO journal_annotations (trade_id, entry_reason, exit_reason, strategy_id) VALUES ($1,$2,$3,$4) ON CONFLICT (trade_id) DO NOTHING`,
      [trade.id, side === 'BUY' ? `Strategy "${s.name}": ${d.entry}`.slice(0, 1000) : null, side === 'SELL' ? `Strategy "${s.name}": ${d.exit || 'stop or target'}`.slice(0, 1000) : null, s.id]);
    res.json({ trade, portfolio: await paper.portfolio(lookup) });
  }));

  // ---- risk simulator: reads the portfolio and writes nothing
  app.post('/api/risk/simulate', wrap(async (req, res) => {
    const scenario = normalizeScenario(req.body, markets.isActive);
    const pf = await paper.portfolio(lookup);
    const unpriced = pf.positions.filter((p) => p.marketValue === null).map((p) => p.symbol);
    const current = scenario.useCurrent ? pf.positions.filter((p) => p.marketValue !== null).map((p) => ({ symbol: p.symbol, value: p.marketValue })) : [];
    const positions = [...current];
    for (const h of scenario.hypothetical) {
      const existing = positions.find((p) => p.symbol === h.symbol);
      if (existing) existing.value += h.value;
      else positions.push({ symbol: h.symbol, value: h.value });
    }
    const cash = scenario.useCurrent ? pf.cash : 0;
    const needed = new Set([...positions.map((p) => p.symbol), ...markets.active().slice(0, 1)]);
    const returnsBySymbol = {};
    const levels = {};
    await Promise.all([...needed].map(async (s) => {
      const candles = (await historyFor(s, '1h')).filter((c) => c.closed !== false);
      const closes = candles.map((c) => c.close);
      returnsBySymbol[s] = closes.slice(1).map((c, i) => c / closes[i] - 1);
      const price = closes[closes.length - 1];
      levels[s] = { price, ...supportResistance(candles, price) };
    }));
    res.json({ ...simulateRisk({ positions, cash, returnsBySymbol, btcSymbol: markets.active()[0], levels }, scenario), unpriced, account: { cash: pf.cash, positions: pf.positions.length, equity: pf.equity } });
  }));

  // ---- trading journal
  app.get('/api/journal', wrap(async (req, res) => res.json({ ...(await journal.load(req.query)), ai: aiStatus() })));
  app.put('/api/journal/trades/:id/annotation', wrap(async (req, res) => res.json(await journal.annotate(req.params.id, req.body))));
  app.post('/api/journal/review', wrap(async (_req, res) => {
    const { analysis, weekly } = await journal.load({ limit: 1 });
    if (!analysis.closedTrips) return res.status(404).json({ error: 'There are no closed trades to review yet' });
    const reply = await aiComplete({ system: REVIEW_SYSTEM, user: JSON.stringify({ analysis, weekly: weekly.slice(0, 4) }), client: ctx.aiClient });
    res.json({ text: reply.text, model: reply.model, generatedAt: Date.now(), ai: aiStatus() });
  }));

  return { journal, replay };
}
