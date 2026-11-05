import { useEffect, useState } from 'react';
import { api, fmt, pct, time, tone } from '../../lib.js';
import { baseOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

const RISK_STYLE = { Low: 'border-lime-neon/50 text-lime-neon', Medium: 'border-amber-neon/50 text-amber-neon', High: 'border-rose-neon/50 text-rose-neon' };
const CRITERIA = { riskAdjusted: 'Return per unit of drawdown', sharpe: 'Sharpe ratio', drawdown: 'Maximum drawdown', trades: 'Completed trades', duration: 'Verified duration', consistency: 'Consistency' };
const num = (v, d = 2) => (Number.isFinite(v) ? fmt(v, d) : '—');
const percent = (v, d = 2) => (Number.isFinite(v) ? pct(v, d) : '—');

const Risk = ({ level }) => <span data-arena-risk={level} className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${RISK_STYLE[level] || ''}`}>{level} risk</span>;

function ProfileForm({ me, onSaved }) {
  const [handle, setHandle] = useState(me.profile?.handle || '');
  const [bio, setBio] = useState(me.profile?.bio || '');
  const [err, setErr] = useState('');
  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try { await api('/api/arena/me', { method: 'PUT', body: { handle, bio } }); onSaved(); } catch (x) { setErr(x.message); }
  };
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={save} data-arena-profile-form>
      <label className="flex flex-col gap-1"><span className="label">Handle</span><input id="arena-handle" className="field w-44 py-1" maxLength={24} value={handle} onChange={(e) => setHandle(e.target.value)} /></label>
      <label className="flex min-w-[220px] flex-1 flex-col gap-1"><span className="label">Bio</span><input id="arena-bio" className="field py-1" maxLength={500} value={bio} onChange={(e) => setBio(e.target.value)} /></label>
      <button type="submit" className="btn btn-cyan" data-arena-profile-save>{me.profile ? 'Save profile' : 'Create profile'}</button>
      {err && <p role="alert" className="w-full text-sm text-rose-neon">{err}</p>}
    </form>
  );
}

function PublishForm({ categories, onDone }) {
  const strategies = useApi('/api/strategies');
  const approved = (strategies.data || []).filter((s) => s.status === 'approved');
  const [strategyId, setStrategyId] = useState('');
  const [category, setCategory] = useState('trend');
  const [description, setDescription] = useState('');
  const [sharePaper, setSharePaper] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const chosen = strategyId || approved[0]?.id || '';

  const publish = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('/api/arena/publish', { method: 'POST', body: { strategyId: chosen, category, description, sharePaper, confirmed } });
      setDescription('');
      setConfirmed(false);
      setSharePaper(false);
      onDone(r.id);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  if (strategies.data && !approved.length) return <Empty>Only approved strategies can be published. Create and approve one in the Strategy builder first.</Empty>;
  return (
    <div className="flex flex-col gap-3" data-arena-publish>
      <Status loading={strategies.loading} error={strategies.error} data={strategies.data} what="your strategies" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1"><span className="label">Approved strategy</span>
          <select id="arena-strategy" className="field py-1" value={chosen} onChange={(e) => setStrategyId(e.target.value)}>
            {approved.map((s) => <option key={s.id} value={s.id}>{s.name} ({baseOf(s.config.symbol)} {s.config.interval})</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1"><span className="label">Category</span>
          <select id="arena-category" className="field py-1" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1"><span className="label">Description</span><textarea id="arena-description" className="field min-h-[70px]" maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="flex items-start gap-2 text-xs text-slate-300"><input id="arena-share" type="checkbox" className="mt-0.5" checked={sharePaper} onChange={(e) => setSharePaper(e.target.checked)} />
        <span>Also share verified paper results for this strategy. Only percentages from trades it places after this point are shown, never balances, sizes or individual trades. Off by default, and you can turn it off later.</span></label>
      <label className="flex items-start gap-2 text-xs text-slate-300"><input id="arena-confirm" type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I want to publish these rules. The server runs its own backtest, and no figures can be typed in.</span></label>
      <div><button type="button" className="btn btn-cyan" data-arena-publish-go disabled={busy || !confirmed} onClick={publish}>{busy ? 'Running backtest…' : 'Publish'}</button></div>
      {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
    </div>
  );
}

function ReportButton({ type, id }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState(null);
  const send = async () => {
    try {
      await api('/api/arena/reports', { method: 'POST', body: { targetType: type, targetId: id, reason } });
      setMsg({ ok: true, text: 'Report sent.' });
      setOpen(false);
    } catch (x) { setMsg({ ok: false, text: x.message }); }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <button type="button" className="text-mute underline" data-arena-report={`${type}-${id}`} onClick={() => setOpen((o) => !o)}>Report</button>
      {open && <><input aria-label="What is wrong" data-arena-report-reason className="field w-48 py-0.5" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /><button type="button" className="seg" data-arena-report-send onClick={send}>Send</button></>}
      {msg && <span role="status" className={msg.ok ? 'text-lime-neon' : 'text-rose-neon'}>{msg.text}</span>}
    </span>
  );
}

function ResultGroup({ title, tag, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2"><h3 className="label">{title}</h3><span className="rounded border border-ink-600 px-1.5 text-[10px] text-mute">{tag}</span></div>
      {children}
    </div>
  );
}

function Detail({ id, onChanged, onClose }) {
  const { data: s, error, loading, reload } = useApi(`/api/arena/strategies/${id}`);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState(null);
  const run = async (fn, ok) => {
    setMsg(null);
    try {
      await fn();
      await reload();
      onChanged();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (x) { setMsg({ ok: false, text: x.message }); }
  };
  if (!s) return <section className="panel" data-arena-detail><Status loading={loading} error={error} data={s} what="this strategy" /></section>;
  const b = s.backtest?.metrics;
  const o = s.backtest?.outOfSample;
  const p = s.paper;
  return (
    <section className="panel flex flex-col gap-3" data-arena-detail={s.id}>
      <div className="panel-title"><span>{s.name}</span><button type="button" className="seg" data-arena-close onClick={onClose}>Close</button></div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-mute">
        <Risk level={s.riskRating} /><span>{s.categoryLabel}</span><span>{baseOf(s.symbol)} {s.interval}</span><span>by {s.profile.handle}</span><span className="num">Published {time(s.publishedAt)}</span>
        {s.status === 'withdrawn' && <span className="text-amber-neon">Withdrawn</span>}
      </div>
      <p className="whitespace-pre-wrap text-sm text-slate-200" data-arena-description>{s.description}</p>
      <div className="text-xs text-slate-300" data-arena-rules>
        <p><span className="label">Entry </span>{s.rules.entry}</p>
        <p><span className="label">Exit </span>{s.rules.exit || 'Stop or target only'}</p>
        <p className="text-mute">{s.riskReasons.join('. ')}.</p>
      </div>

      <ResultGroup title="Historical backtest" tag="SIMULATED ON PAST DATA">
        {b ? (
          <div data-arena-backtest className="flex flex-col gap-2">
            <StatGrid>
              <Stat label="Return" value={percent(b.totalReturnPct)} className={tone(b.totalReturnPct)} note={o ? `Unseen data ${percent(o.totalReturnPct)}` : undefined} />
              <Stat label="Max drawdown" value={`${num(b.maxDrawdownPct)}%`} />
              <Stat label="Sharpe" value={num(b.sharpe)} />
              <Stat label="Trades" value={b.trades} />
              <Stat label="Consistency" value={Number.isFinite(s.backtest.consistencyPct) ? `${num(s.backtest.consistencyPct, 0)}%` : '—'} note="Slices not losing" />
              <Stat label="Verdict" value={s.backtest.verdict} />
            </StatGrid>
            <p className="num text-[11px] text-mute">Computed by this server {time(s.backtest.computedAt)} from {s.backtest.candlesUsed} Binance candles, with a {s.backtest.assumptions?.feeRatePct}% fee and {s.backtest.assumptions?.slippageBps} bps slippage. Past results are not guarantees.</p>
          </div>
        ) : <Empty>No backtest result.</Empty>}
      </ResultGroup>

      <ResultGroup title="Verified paper trading" tag="LIVE PRICES, NO REAL MONEY">
        {!s.paperShared && <Empty>The owner has not shared paper results for this strategy.</Empty>}
        {s.paperShared && !p && <Empty>Sharing is on. No orders placed by this strategy have been recorded since then.</Empty>}
        {p && (
          <div data-arena-paper className="flex flex-col gap-2">
            <StatGrid>
              <Stat label="Return" value={percent(p.totalReturnPct)} className={tone(p.totalReturnPct)} />
              <Stat label="Max drawdown" value={`${num(p.maxDrawdownPct)}%`} />
              <Stat label="Sharpe" value={num(p.sharpe)} />
              <Stat label="Completed trades" value={p.completedTrades} />
              <Stat label="Verified for" value={`${num(p.durationDays, 1)} days`} />
              <Stat label="Consistency" value={Number.isFinite(p.consistencyPct) ? `${num(p.consistencyPct, 0)}%` : '—'} />
            </StatGrid>
            <p className="text-[11px] text-mute">Only orders the approved strategy placed on this server count, and each counts once. {p.returnBasis}</p>
          </div>
        )}
      </ResultGroup>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost" data-arena-copy onClick={() => run(() => api(`/api/arena/strategies/${s.id}/copy`, { method: 'POST' }), 'Copied to the Strategy builder as a draft. Review and approve it before any use.')}>Copy to builder</button>
        <button type="button" className="seg" aria-pressed={s.isFavourite} data-arena-fav onClick={() => run(() => api(`/api/arena/strategies/${s.id}/favourite`, { method: s.isFavourite ? 'DELETE' : 'PUT' }))}>{s.isFavourite ? 'Saved' : 'Save as favourite'}</button>
        {!s.mine && <button type="button" className="seg" aria-pressed={s.followingCreator} data-arena-follow onClick={() => run(() => api(`/api/arena/profiles/${s.profile.id}/follow`, { method: s.followingCreator ? 'DELETE' : 'PUT' }))}>{s.followingCreator ? `Following ${s.profile.handle}` : `Follow ${s.profile.handle}`}</button>}
        {s.mine && <button type="button" className="btn btn-ghost" data-arena-rerun onClick={() => run(() => api(`/api/arena/strategies/${s.id}/backtest`, { method: 'POST' }), 'Backtest updated.')}>Re-run backtest</button>}
        {s.mine && <button type="button" className="seg" aria-pressed={s.paperShared} data-arena-share onClick={() => run(() => api(`/api/arena/strategies/${s.id}`, { method: 'PATCH', body: { sharePaper: !s.paperShared } }), s.paperShared ? 'Paper results are no longer shared, and the copied record was removed.' : 'Sharing is on from now.')}>{s.paperShared ? 'Stop sharing paper results' : 'Share paper results'}</button>}
        {s.mine && s.status === 'published' && <button type="button" className="btn btn-ghost" data-arena-withdraw onClick={() => run(async () => { await api(`/api/arena/strategies/${s.id}/withdraw`, { method: 'POST' }); }, 'Withdrawn from the leaderboard.')}>Withdraw</button>}
        {!s.mine && <ReportButton type="strategy" id={s.id} />}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs" data-arena-rating>
        <span className="label">Rating</span>
        <span className="num">{s.rating.count ? `${num(s.rating.average, 1)} of 5, ${s.rating.count} ${s.rating.count === 1 ? 'rating' : 'ratings'}` : 'Not rated yet'}</span>
        {!s.mine && [1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className="seg" aria-pressed={s.myRating === n} data-arena-star={n} onClick={() => run(() => api(`/api/arena/strategies/${s.id}/rating`, { method: 'PUT', body: { stars: n } }))}>{n}</button>)}
        {s.mine && <span className="text-mute">You can't rate your own strategy.</span>}
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} data-arena-msg className={`text-sm ${msg.ok ? 'text-lime-neon' : 'text-rose-neon'}`}>{msg.text}</p>}

      <div className="flex flex-col gap-2" data-arena-comments>
        <h3 className="label">Comments ({s.comments.length})</h3>
        <div className="flex flex-wrap gap-2">
          <input id="arena-comment" aria-label="Add a comment" className="field min-w-[200px] flex-1 py-1" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
          <button type="button" className="btn btn-ghost" data-arena-comment-post onClick={() => run(async () => { await api(`/api/arena/strategies/${s.id}/comments`, { method: 'POST', body: { body: comment } }); setComment(''); })}>Post</button>
        </div>
        <ul className="divide-y divide-ink-700 text-sm">
          {s.comments.map((c) => (
            <li key={c.id} className="py-1.5" data-arena-comment={c.id}>
              <p className="whitespace-pre-wrap text-slate-300">{c.body}</p>
              <p className="num text-[11px] text-mute">{c.profile.handle} · {time(c.createdAt)} <ReportButton type="comment" id={c.id} /></p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Moderation({ onChanged }) {
  const { data, error, loading, reload } = useApi('/api/arena/moderation');
  const act = async (url, body) => { await api(url, { method: 'POST', body }); await reload(); onChanged(); };
  return (
    <div className="flex flex-col gap-2" data-arena-moderation>
      <p className="text-xs text-amber-neon">With no accounts yet, anyone who can reach this server can moderate. Add accounts and moderator roles before hosting it.</p>
      <Status loading={loading} error={error} data={data} what="reports" />
      {data && !data.reports.length && <Empty>No reports.</Empty>}
      <ul className="divide-y divide-ink-700 text-xs">
        {data?.reports.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5" data-arena-report-row={r.id}>
            <span>{r.target_type} #{r.target_id}: {r.reason} <span className="text-mute">({r.status}, by {r.reporter})</span></span>
            {r.status === 'open' && (
              <span className="flex gap-1">
                <button type="button" className="seg" data-arena-hide onClick={() => act('/api/arena/moderation', { targetType: r.target_type, targetId: r.target_id, hidden: true, reason: r.reason })}>Hide</button>
                <button type="button" className="seg" data-arena-dismiss onClick={() => act(`/api/arena/moderation/reports/${r.id}/dismiss`)}>Dismiss</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {data?.log.length > 0 && (
        <ul className="num text-[11px] text-mute" data-arena-modlog>
          {data.log.map((l) => <li key={l.id} className="flex flex-wrap items-center gap-2">{time(l.at)} · {l.target_type} #{l.target_id} {l.action}{l.action === 'hidden' && <button type="button" className="underline" data-arena-restore onClick={() => act('/api/arena/moderation', { targetType: l.target_type, targetId: l.target_id, hidden: false, reason: 'Restored' })}>Restore</button>}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function Arena({ symbols }) {
  const me = useApi('/api/arena/me');
  const [basis, setBasis] = useState('backtest');
  const [category, setCategory] = useState('');
  const [risk, setRisk] = useState('');
  const [coin, setCoin] = useState('');
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  const [panel, setPanel] = useState('');
  const q = new URLSearchParams({ basis });
  if (category) q.set('category', category);
  if (risk) q.set('risk', risk);
  if (coin) q.set('symbol', coin);
  if (filter) q.set('filter', filter);
  const board = useApi(`/api/arena/leaderboard?${q}`);
  const categories = me.data?.categories || {};
  const refresh = () => { me.reload(); board.reload(); };
  useEffect(() => { if (me.data && !me.data.profile) setPanel('profile'); }, [me.data]);

  const row = (s) => (
    <tr key={s.id} data-arena-row={s.id} className="cursor-pointer hover:bg-ink-800" onClick={() => setOpenId(s.id)}>
      <td className="py-1.5">{s.rank ?? '—'}</td>
      <td className="font-sans font-semibold"><button type="button" className="text-left underline-offset-2 hover:underline" data-arena-open={s.id}>{s.name}</button><div className="font-normal text-mute">{s.profile.handle} · {s.categoryLabel}</div></td>
      <td>{baseOf(s.symbol)} {s.interval}</td>
      <td><Risk level={s.riskRating} /></td>
      <td>{s.score ?? '—'}</td>
      <td className={tone(s.metrics?.totalReturnPct)}>{percent(s.metrics?.totalReturnPct)}</td>
      <td>{Number.isFinite(s.metrics?.maxDrawdownPct) ? `${num(s.metrics.maxDrawdownPct)}%` : '—'}</td>
      <td>{num(s.metrics?.sharpe)}</td>
      <td>{s.metrics?.trades ?? '—'}</td>
      <td>{Number.isFinite(s.metrics?.consistencyPct) ? `${num(s.metrics.consistencyPct, 0)}%` : '—'}</td>
      {basis === 'paper' && <td>{Number.isFinite(s.metrics?.durationDays) ? `${num(s.metrics.durationDays, 1)}d` : '—'}</td>}
      <td>{s.rating.count ? `${num(s.rating.average, 1)} (${s.rating.count})` : '—'}</td>
    </tr>
  );

  const total = (board.data?.ranked.length ?? 0) + (board.data?.unranked.length ?? 0);
  return (
    <div className="flex flex-col gap-4" data-arena>
      <p className="text-xs text-amber-neon" data-arena-notice>{me.data?.notice}</p>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>{me.data?.profile ? `Your profile: ${me.data.profile.handle}` : 'Your profile'}</span>
          <span className="flex flex-wrap gap-1">
            {[['profile', 'Profile'], ['publish', 'Publish'], ['mine', 'My strategies'], ['moderation', 'Moderation']].map(([k, label]) => <button key={k} type="button" className="seg" aria-pressed={panel === k} data-arena-panel={k} onClick={() => setPanel(panel === k ? '' : k)}>{label}</button>)}
          </span>
        </div>
        <Status loading={me.loading} error={me.error} data={me.data} what="your profile" />
        {panel === 'profile' && me.data && <ProfileForm key={me.data.profile?.id ?? 'new'} me={me.data} onSaved={refresh} />}
        {panel === 'publish' && (me.data?.profile
          ? <PublishForm categories={categories} onDone={(id) => { refresh(); setOpenId(id); setPanel(''); }} />
          : <Empty>Create your profile first.</Empty>)}
        {panel === 'mine' && (
          <ul className="divide-y divide-ink-700 text-sm" data-arena-mine>
            {me.data?.strategies.map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span>{s.name} <span className="text-xs text-mute">{s.status}{s.hidden ? ', hidden by moderation' : ''}</span></span><button type="button" className="seg" onClick={() => setOpenId(s.id)}>Open</button></li>)}
            {me.data && !me.data.strategies.length && <Empty>You have not published anything.</Empty>}
          </ul>
        )}
        {panel === 'moderation' && <Moderation onChanged={refresh} />}
      </section>

      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Leaderboard</span>
          <span className="flex gap-1" role="group" aria-label="Result type">
            <button type="button" className="seg" aria-pressed={basis === 'backtest'} data-arena-basis="backtest" onClick={() => setBasis('backtest')}>Backtests</button>
            <button type="button" className="seg" aria-pressed={basis === 'paper'} data-arena-basis="paper" onClick={() => setBasis('paper')}>Verified paper</button>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1"><span className="label">Category</span><select id="arena-f-category" className="field py-1" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All</option>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="label">Risk</span><select id="arena-f-risk" className="field py-1" value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">All</option><option>Low</option><option>Medium</option><option>High</option></select></label>
          <label className="flex flex-col gap-1"><span className="label">Coin</span><select id="arena-f-coin" className="field py-1" value={coin} onChange={(e) => setCoin(e.target.value)}><option value="">All</option>{symbols.map((s) => <option key={s} value={s}>{baseOf(s)}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="label">Show</span><select id="arena-f-filter" className="field py-1" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">Everything</option><option value="favourites">My favourites</option><option value="following">Creators I follow</option></select></label>
        </div>
        <Status loading={board.loading} error={board.error} data={board.data} what="the leaderboard" />
        {board.data && !total && <Empty>Nothing has been published here yet. The list stays empty until a real strategy is published.</Empty>}
        {total > 0 && (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[860px] text-xs" data-arena-table>
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">#</th><th className="font-normal">Strategy</th><th className="font-normal">Market</th><th className="font-normal">Risk</th><th className="font-normal">Score</th><th className="font-normal">Return</th><th className="font-normal">Max DD</th><th className="font-normal">Sharpe</th><th className="font-normal">Trades</th><th className="font-normal">Consistency</th>{basis === 'paper' && <th className="font-normal">Verified</th>}<th className="font-normal">Rating</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {board.data.ranked.map(row)}
                {board.data.unranked.map(row)}
              </tbody>
            </table>
          </div>
        )}
        {board.data?.unranked.length > 0 && <p className="text-[11px] text-mute" data-arena-unranked>Strategies with no rank don't meet the minimum yet: {board.data.unranked[0].reason}.</p>}
        {board.data && (
          <p className="text-[11px] text-mute" data-arena-method>
            {basis === 'backtest' ? 'Simulated on past data, not live results.' : 'Live-price paper orders placed by the approved strategy. No real money.'} Score is a relative blend, out of 100, of {Object.entries(board.data.weights).filter(([k]) => basis === 'paper' || k !== 'duration').map(([k]) => CRITERIA[k].toLowerCase()).join(', ')}. Return alone can't top the table, and at least {board.data.minimumTrades} completed trades are needed to be ranked.
          </p>
        )}
      </section>

      {openId && <Detail key={openId} id={openId} onChanged={refresh} onClose={() => setOpenId(null)} />}
    </div>
  );
}
