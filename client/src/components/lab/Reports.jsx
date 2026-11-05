import { useState } from 'react';
import { api, time } from '../../lib.js';
import { baseOf } from '../../coins.js';
import { useApi, Status, AiBadge, Empty } from './common.jsx';

function Section({ s }) {
  return (
    <section className="flex flex-col gap-1 border-t border-ink-700 pt-3" data-report-section={s.id}>
      <h3 className="text-sm font-semibold text-slate-200">{s.title}</h3>
      <p className="num text-[11px] text-mute" data-section-meta>
        Data as of {time(s.asOf)} · Source: {s.source?.url ? <a className="text-cyan-neon underline" href={s.source.url} target="_blank" rel="noreferrer noopener">{s.source.name}</a> : s.source?.name}
      </p>
      {s.unavailable && <p className="text-xs text-amber-neon" data-section-unavailable>Unavailable: {s.unavailable}</p>}
      {(s.lines || []).map((l, i) => <p key={i} className="text-sm text-slate-300">{l}</p>)}
      {s.articles?.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {s.articles.map((a) => <li key={a.link}><a className="text-cyan-neon underline" href={a.link} target="_blank" rel="noreferrer noopener">{a.title}</a> <span className="num text-[11px] text-mute">{a.source}, {time(a.publishedAt)}</span></li>)}
        </ul>
      )}
      {s.events?.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-slate-300">
          {s.events.map((e) => <li key={e.id}><a className="text-cyan-neon underline" href={e.source_url} target="_blank" rel="noreferrer noopener">{e.title}</a> <span className="num text-[11px] text-mute">{e.starts_at ? time(e.starts_at) : `${e.event_date}, time not published`} · {e.currency} · forecast {e.forecast ?? '—'} · previous {e.previous ?? '—'}</span></li>)}
        </ul>
      )}
    </section>
  );
}

export default function Reports({ symbol, symbols, onSelect }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState('');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (kind) q.set('kind', kind);
  const archive = useApi(`/api/reports?${q}`);
  const open = useApi(openId ? `/api/reports/${openId}` : null);
  const report = openId ? open.data : null;

  const generate = async (body, label) => {
    setBusy(label);
    setErr('');
    try {
      const r = await api('/api/reports/generate', { method: 'POST', body });
      await archive.reload();
      setOpenId(r.id);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  return (
    <div className="flex flex-col gap-4" data-reports>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Create a report</span><AiBadge ai={archive.data?.ai} /></div>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className="btn btn-cyan" data-report-daily disabled={Boolean(busy)} onClick={() => generate({ kind: 'daily' }, 'daily')}>{busy === 'daily' ? 'Building…' : 'Daily market report'}</button>
          <label className="flex flex-col gap-1"><span className="label">Coin</span>
            <select id="report-coin" className="field py-1" value={symbol} onChange={(e) => onSelect(e.target.value)}>
              {symbols.map((s) => <option key={s} value={s}>{baseOf(s)}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" data-report-coin disabled={Boolean(busy)} onClick={() => generate({ kind: 'coin', symbol }, 'coin')}>{busy === 'coin' ? 'Building…' : `${baseOf(symbol)} report`}</button>
        </div>
        <p className="text-xs text-mute">A daily report is also saved automatically once per UTC day while the server is running.</p>
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
      </section>

      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Report archive</span></div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1"><span className="label">From</span><input id="report-from" type="date" className="field py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className="label">To</span><input id="report-to" type="date" className="field py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className="label">Type</span>
            <select id="report-kind" className="field py-1" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option><option value="daily">Daily</option><option value="coin">Coin</option>
            </select>
          </label>
        </div>
        <Status loading={archive.loading} error={archive.error} data={archive.data} what="the archive" />
        {archive.data && !archive.data.reports.length && <Empty>No reports for this selection.</Empty>}
        <ul className="divide-y divide-ink-700" data-report-archive>
          {archive.data?.reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm" data-report-row={r.id}>
              <span>{r.title} <span className="num text-[11px] text-mute">{r.report_date} · {time(r.generated_at)} · {r.trigger === 'schedule' ? 'automatic' : 'manual'}</span></span>
              <span className="flex gap-1">
                <button type="button" className="seg" aria-pressed={openId === r.id} data-report-open={r.id} onClick={() => setOpenId(r.id)}>Open</button>
                <a className="seg" href={`/api/reports/${r.id}/pdf`} data-report-pdf={r.id}>PDF</a>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {openId && (
        <section className="panel flex flex-col gap-3" data-report-view>
          <Status loading={open.loading} error={open.error} data={open.data} what="the report" />
          {report && (
            <>
              <div className="panel-title"><span>{report.title}</span><a className="btn btn-ghost" href={`/api/reports/${report.id}/pdf`}>Export PDF</a></div>
              <p className="num text-[11px] text-mute">Generated {time(report.generated_at)}. Report date {report.report_date} (UTC). Times on this page are in your time zone, {Intl.DateTimeFormat().resolvedOptions().timeZone}. The PDF uses UTC.</p>
              <div data-report-summary>
                <h3 className="label">{report.ai_summary ? `Executive summary, written by AI (${report.ai_model})` : 'Executive summary, from rules and not AI'}</h3>
                <p className="text-sm text-slate-200">{report.ai_summary || report.content.ruleSummary}</p>
                {report.content.aiError && <p className="text-xs text-amber-neon">AI unavailable: {report.content.aiError}</p>}
              </div>
              {report.content.sections.map((s) => <Section key={s.id} s={s} />)}
              <p className="text-[11px] text-mute">{report.content.disclaimer}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
