// Routes for Phase 3: Economic Calendar, Research Reports and Autopilot.
import { aiStatus } from '../ai.js';
import { CATEGORIES, createCalendar } from './calendar.js';
import { createReports, DISCLAIMER } from './reports.js';
import { CONDITIONS, createAutopilot } from './autopilot.js';

const CALENDAR_EVERY_MS = 30 * 60e3;
const REPORT_CHECK_EVERY_MS = 15 * 60e3;
const AUTOPILOT_EVERY_MS = 5 * 60e3;

export function attachAutomation(app, ctx, deps) {
  const { pool, markets, cached, wrap, sym, historyFor, overviewFor, tickersNow, fetchImpl, aiClient } = ctx;
  const { tracker, news, forecastFor, orderBook, futures, exchanges, liquidations } = deps;

  const calendar = createCalendar({ pool, cached, fetchImpl: fetchImpl || globalThis.fetch, aiClient });
  const reports = createReports({ pool, tickersNow, overviewFor, forecastFor, historyFor, tracker, news, calendar, orderBook, futures, exchanges, liquidations, isActive: markets.isActive, aiClient });
  // the paper-trading module is deliberately not passed to Autopilot
  const autopilot = createAutopilot({ pool, markets, historyFor, tickersNow, forecastFor, news, calendar, aiClient });

  // ---- calendar
  app.get('/api/calendar', wrap(async (req, res) => {
    await calendar.ensureFresh();
    const { from, to, importance, category } = req.query;
    res.json({
      events: await calendar.list({ from, to, importance, category }),
      sources: calendar.sources(),
      lastSync: calendar.lastSync(),
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
      notConnected: [{ name: 'Major cryptocurrency events', detail: 'No reliable free source is connected, so crypto-specific events (upgrades, unlocks, conferences) are not listed.' }],
      coverage: 'Scheduled data releases come from a weekly export that covers the current week only, so they build up here as weeks pass. FOMC dates are listed further ahead. Regulatory items are past announcements that have already been published.',
      timezone: 'Stored in UTC. Date-only events have no published time.',
    });
  }));
  app.post('/api/calendar/:id/explain', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'No such event' });
    res.json(await calendar.explain(id));
  }));

  // ---- reports
  const symbolQuery = (v) => (v ? sym(v) : null);
  app.get('/api/reports', wrap(async (req, res) => {
    const { from, to, kind, limit } = req.query;
    if (kind && !['daily', 'coin'].includes(kind)) return res.status(400).json({ error: 'Report type must be daily or coin' });
    res.json({ reports: await reports.list({ from, to, kind, symbol: symbolQuery(req.query.symbol), limit }), disclaimer: DISCLAIMER, ai: aiStatus() });
  }));
  app.post('/api/reports/generate', wrap(async (req, res) => {
    const kind = String(req.body?.kind || 'daily');
    if (kind === 'coin' && !req.body?.symbol) return res.status(400).json({ error: 'Choose a coin for a coin report' });
    res.json(await reports.generate({ kind, symbol: kind === 'coin' ? sym(req.body?.symbol) : null, trigger: 'manual' }));
  }));
  app.get('/api/reports/:id', wrap(async (req, res) => res.json(await reports.get(req.params.id))));
  app.get('/api/reports/:id/pdf', wrap(async (req, res) => {
    const { filename, buffer } = await reports.pdf(req.params.id);
    res.set({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${filename}"` }).send(buffer);
  }));

  // ---- autopilot
  app.get('/api/autopilot/settings', wrap(async (_req, res) => {
    res.json({ settings: await autopilot.getSettings(), conditions: CONDITIONS, mode: 'Research only. Autopilot never places orders or changes positions.', everyMinutes: AUTOPILOT_EVERY_MS / 60e3 });
  }));
  app.put('/api/autopilot/settings', wrap(async (req, res) => res.json({ settings: await autopilot.updateSettings(req.body) })));
  app.post('/api/autopilot/pause', wrap(async (_req, res) => res.json({ settings: await autopilot.pause() })));
  app.post('/api/autopilot/resume', wrap(async (_req, res) => res.json({ settings: await autopilot.resume() })));
  app.post('/api/autopilot/run', wrap(async (_req, res) => {
    await autopilot.audit('manual_run');
    res.json(await autopilot.runOnce('manual'));
  }));
  app.get('/api/autopilot/events', wrap(async (req, res) => res.json(await autopilot.listEvents({ limit: req.query.limit, symbol: symbolQuery(req.query.symbol) }))));
  app.post('/api/autopilot/events/read', wrap(async (_req, res) => { await autopilot.markRead(); res.json({ ok: true }); }));
  app.get('/api/autopilot/runs', wrap(async (req, res) => res.json(await autopilot.listRuns(req.query.limit))));
  app.get('/api/autopilot/audit', wrap(async (req, res) => res.json(await autopilot.listAudit(req.query.limit))));

  function startJobs() {
    const safely = (name, fn) => () => Promise.resolve().then(fn).catch((e) => console.warn(`[${name}] ${e.message}`));
    const syncCalendar = safely('calendar', () => calendar.sync());
    const daily = safely('reports', () => reports.ensureDaily());
    const pilot = safely('autopilot', async () => { await autopilot.tick(); await autopilot.purgeRuns(); });
    syncCalendar();
    const a = setInterval(syncCalendar, CALENDAR_EVERY_MS);
    const b = setInterval(daily, REPORT_CHECK_EVERY_MS);
    const c = setInterval(pilot, AUTOPILOT_EVERY_MS);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); };
  }

  return { calendar, reports, autopilot, startJobs };
}
