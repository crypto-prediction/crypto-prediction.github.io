import { useState } from 'react';
import { api, fmt, pct, price, time, tone, usd } from '../../lib.js';
import { baseOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, AiBadge, Empty } from './common.jsx';

const PAGE = 25;
const hoursText = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const h = ms / 3600e3;
  return h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};

function Notes({ trip, strategies, onSaved }) {
  const a = trip.annotation || {};
  const [form, setForm] = useState({ entryReason: a.entry_reason || '', exitReason: a.exit_reason || '', strategyId: a.strategy_id || '', note: a.note || '' });
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function save(e) {
    e.preventDefault();
    try {
      await api(`/api/journal/trades/${trip.id}/annotation`, { method: 'PUT', body: form });
      setMsg('Saved.');
      onSaved();
    } catch (x) { setMsg(x.message); }
  }
  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2" data-notes>
      <label className="flex flex-col gap-1"><span className="label">Why you entered</span><input data-entry-reason className="field py-1 text-xs" maxLength={1000} value={form.entryReason} onChange={set('entryReason')} /></label>
      <label className="flex flex-col gap-1"><span className="label">Why you exited</span><input data-exit-reason className="field py-1 text-xs" maxLength={1000} value={form.exitReason} onChange={set('exitReason')} /></label>
      <label className="flex flex-col gap-1"><span className="label">Strategy</span><select data-note-strategy className="field py-1 text-xs" value={form.strategyId} onChange={set('strategyId')}><option value="">None</option>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="flex flex-col gap-1"><span className="label">Your notes</span><input data-note className="field py-1 text-xs" maxLength={1000} value={form.note} onChange={set('note')} /></label>
      <div className="flex items-center gap-2 sm:col-span-2"><button className="btn btn-ghost py-1" data-save-notes>Save notes</button>{msg && <span role="status" className="text-xs text-mute">{msg}</span>}</div>
      {trip.context && <p className="text-[11px] text-mute sm:col-span-2">Market when opened (1h candles): {trip.context.trend}, RSI {trip.context.rsi === null ? '—' : fmt(trip.context.rsi, 1)}, momentum {pct(trip.context.momentumPct)}, volatility {pct(trip.context.volatilityPct, 2, false)}.</p>}
      {trip.timing && <p className="text-[11px] text-mute sm:col-span-2">While open: best gain {pct(trip.timing.maxGainPct)}, worst drop -{fmt(trip.timing.maxDrawdownPct, 2)}%. Entry timing {fmt(trip.timing.entryEfficiency * 100, 0)}%, exit timing {fmt(trip.timing.exitEfficiency * 100, 0)}% (100% is the best price in that range).</p>}
    </form>
  );
}

function Breakdown({ title, rows, name = (k) => k }) {
  return (
    <div>
      <div className="label mb-1">{title}</div>
      {!rows.length ? <Empty>Nothing yet.</Empty> : (
        <table className="num w-full text-xs">
          <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Group</th><th className="font-normal">Trades</th><th className="font-normal">Won</th><th className="font-normal">P&amp;L</th></tr></thead>
          <tbody className="divide-y divide-ink-700">{rows.map((g) => <tr key={g.key}><td className="py-1">{name(g.key)}</td><td>{g.trips}</td><td>{g.wins}</td><td className={tone(g.pnl)}>{usd(g.pnl)}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

export default function Journal() {
  const [offset, setOffset] = useState(0);
  const { data: d, error, loading, reload } = useApi(`/api/journal?limit=${PAGE}&offset=${offset}`, { every: 60000 });
  const strategies = useApi('/api/strategies');
  const [open, setOpen] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewErr, setReviewErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(null);

  async function aiReview() {
    setBusy(true); setReview(null); setReviewErr('');
    try {
      const r = await api('/api/journal/review', { method: 'POST' });
      setReview(r);
      setAi(r.ai);
    } catch (e) { setReviewErr(e.message); }
    finally {
      setBusy(false);
      api('/api/intel/status').then((s) => setAi(s.ai)).catch(() => {});
    }
  }

  if (!d) return <section className="panel"><Status loading={loading} error={error} data={d} what="the journal" /></section>;
  const a = d.analysis;
  return (
    <div className="flex flex-col gap-4" data-journal>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Trading journal</span><AiBadge ai={ai || d.ai} /></div>
        <Status loading={loading} error={error} data={d} what="the journal" />
        <StatGrid>
          <Stat label="Closed trades" value={a.closedTrips} note={`${a.openTrips} open`} />
          <Stat label="Win rate" value={a.winRatePct === null ? '—' : pct(a.winRatePct, 1, false)} />
          <Stat label="Total P&L" value={usd(a.totalPnl)} className={tone(a.totalPnl)} />
          <Stat label="Average win / loss" value={`${a.avgWin === null ? '—' : usd(a.avgWin)} / ${a.avgLoss === null ? '—' : usd(a.avgLoss)}`} />
          <Stat label="Reward / risk" value={a.rewardRisk === null ? '—' : fmt(a.rewardRisk, 2)} />
          <Stat label="Average hold" value={a.avgHoldingHours === null ? '—' : hoursText(a.avgHoldingHours * 3600e3)} note={`Fees ${usd(a.totalFees)}`} />
        </StatGrid>
        <div>
          <div className="label mb-1">Patterns found</div>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-slate-300" data-findings>{a.findings.map((f) => <li key={f}>{f}</li>)}{!a.findings.length && <li>No recurring problem found in {a.closedTrips} closed trades.</li>}</ul>
          <p className="mt-1 text-[11px] text-mute">Worked out by rules from your real paper trades, not by AI.</p>
        </div>
        {(ai || d.ai)?.configured && (
          <div className="rounded border border-violet-neon/30 bg-violet-neon/5 p-3" data-ai-review>
            <div className="flex items-center justify-between gap-2"><span className="label text-violet-neon">AI-written review</span><button type="button" className="btn btn-ghost py-1" disabled={busy} onClick={aiReview}>{busy ? 'Writing…' : 'Write review'}</button></div>
            {reviewErr && <p role="alert" className="mt-1 text-xs text-rose-neon">{reviewErr}</p>}
            {review && <p className="mt-1 text-sm leading-relaxed text-slate-300">{review.text}</p>}
          </div>
        )}
      </section>

      <section className="panel flex flex-col gap-2" data-trips>
        <div className="panel-title"><span>Trades</span><span className="num font-normal normal-case tracking-normal text-mute">{d.totalTrips} round trips, from your paper account</span></div>
        {!d.trips.length ? <Empty>No paper trades yet. Your trades appear here automatically.</Empty> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[820px] text-xs">
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Opened</th><th className="font-normal">Held</th><th className="font-normal">Size</th><th className="font-normal">Entry</th><th className="font-normal">Exit</th><th className="font-normal">Fees</th><th className="font-normal">P&amp;L</th><th className="font-normal">Strategy</th><th /></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {d.trips.flatMap((t) => [
                  <tr key={t.id} data-trip={t.id}>
                    <td className="py-1">{baseOf(t.symbol)}{t.status === 'open' ? ' (open)' : ''}</td><td>{time(t.openedAt)}</td><td>{hoursText(t.holdingMs)}</td><td>{usd(t.sizeUsd)}</td><td>{price(t.entryPrice)}</td><td>{t.exitPrice === null ? '—' : price(t.exitPrice)}</td><td>{usd(t.fees)}</td><td className={tone(t.pnl)}>{t.pnl === null ? '—' : usd(t.pnl)}</td><td className="text-mute">{t.strategyName || '—'}</td>
                    <td className="text-right"><button type="button" data-open-notes={t.id} className="seg py-0" aria-pressed={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>Notes</button></td>
                  </tr>,
                  open === t.id && <tr key={`${t.id}-notes`}><td colSpan={10} className="bg-ink-950/60"><Notes trip={t} strategies={strategies.data || []} onSaved={reload} /></td></tr>,
                ])}
              </tbody>
            </table>
          </div>
        )}
        {d.totalTrips > PAGE && (
          <div className="flex items-center gap-2 text-xs">
            <button type="button" className="seg" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
            <span className="num text-mute">{offset + 1}–{Math.min(offset + PAGE, d.totalTrips)} of {d.totalTrips}</span>
            <button type="button" className="seg" disabled={offset + PAGE >= d.totalTrips} onClick={() => setOffset(offset + PAGE)}>Older</button>
          </div>
        )}
        <p className="text-[11px] text-mute">The journal only reads your paper trades and never changes them. Notes are stored separately.</p>
      </section>

      <section className="panel grid grid-cols-1 gap-4 lg:grid-cols-3" data-breakdowns>
        <Breakdown title="By strategy" rows={a.byStrategy} />
        <Breakdown title="By cryptocurrency" rows={a.byCoin} name={baseOf} />
        <Breakdown title="By market when opened" rows={a.byMarket} />
      </section>

      <section className="panel" data-weekly>
        <div className="panel-title"><span>Weekly reviews</span></div>
        {!d.weekly.length ? <Empty>A review appears once a week has closed trades.</Empty> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[560px] text-xs">
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Week of</th><th className="font-normal">Trades</th><th className="font-normal">Won</th><th className="font-normal">P&amp;L</th><th className="font-normal">Fees</th><th className="font-normal">Best</th><th className="font-normal">Worst</th></tr></thead>
              <tbody className="divide-y divide-ink-700">{d.weekly.map((w) => <tr key={w.week}><td className="py-1">{w.week}</td><td>{w.trips}</td><td>{w.wins}</td><td className={tone(w.pnl)}>{usd(w.pnl)}</td><td>{usd(w.fees)}</td><td>{baseOf(w.best.symbol)} {usd(w.best.pnl)}</td><td>{baseOf(w.worst.symbol)} {usd(w.worst.pnl)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
