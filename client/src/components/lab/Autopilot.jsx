import { useEffect, useState } from 'react';
import { api, time } from '../../lib.js';
import { baseOf } from '../../coins.js';
import { useApi, Status, Empty } from './common.jsx';

const INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export default function Autopilot({ symbols }) {
  const cfg = useApi('/api/autopilot/settings');
  const events = useApi('/api/autopilot/events?limit=50', { every: 30000 });
  const runs = useApi('/api/autopilot/runs?limit=15', { every: 30000 });
  const audit = useApi('/api/autopilot/audit?limit=20');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const s = cfg.data?.settings;
    if (!s) return;
    setForm({ symbols: s.symbols, intervals: s.intervals, conditions: s.conditions, notify: s.notify, quietStart: s.quiet_start || '', quietEnd: s.quiet_end || '', quietTimeZone: s.quiet_tz === 'UTC' && !s.quiet_start ? LOCAL_ZONE : s.quiet_tz });
  }, [cfg.data]);

  const act = async (label, fn, ok) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      await Promise.all([cfg.reload(), events.reload(), runs.reload(), audit.reload()]);
      setMsg({ ok: true, text: ok });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); }
  };

  const s = cfg.data?.settings;
  const save = () => act('save', () => api('/api/autopilot/settings', { method: 'PUT', body: form }), 'Settings saved.');
  const setEnabled = (enabled) => act('enable', () => api('/api/autopilot/settings', { method: 'PUT', body: { enabled } }), enabled ? 'Autopilot is on.' : 'Autopilot is off.');
  const run = () => act('run', () => api('/api/autopilot/run', { method: 'POST' }), 'Run finished. See the log below.');
  const stateText = !s ? '' : !s.enabled ? 'Off' : s.paused ? 'Paused' : 'Monitoring';

  return (
    <div className="flex flex-col gap-4" data-autopilot>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Signal Lab Autopilot</span><span data-ap-state className={`rounded border px-2 py-0.5 text-[10px] ${stateText === 'Monitoring' ? 'border-lime-neon/50 text-lime-neon' : 'border-ink-600 text-mute'}`}>{stateText.toUpperCase()}</span></div>
        <p className="text-sm text-slate-300" data-ap-mode>{cfg.data?.mode} It records findings for you to review, and checks every {cfg.data?.everyMinutes} minutes while on.</p>
        <Status loading={cfg.loading} error={cfg.error} data={cfg.data} what="Autopilot settings" />
        {s && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={s.enabled ? 'btn btn-ghost' : 'btn btn-cyan'} data-ap-enable disabled={Boolean(busy)} onClick={() => setEnabled(!s.enabled)}>{s.enabled ? 'Turn off' : 'Turn on'}</button>
            {s.enabled && <button type="button" className="btn btn-ghost" data-ap-pause disabled={Boolean(busy)} onClick={() => act('pause', () => api(`/api/autopilot/${s.paused ? 'resume' : 'pause'}`, { method: 'POST' }), s.paused ? 'Monitoring resumed.' : 'Monitoring paused.')}>{s.paused ? 'Resume' : 'Pause'}</button>}
            <button type="button" className="btn btn-ghost" data-ap-run disabled={Boolean(busy)} onClick={run}>{busy === 'run' ? 'Running…' : 'Run one check now'}</button>
          </div>
        )}
        {msg && <p role={msg.ok ? 'status' : 'alert'} data-ap-msg className={`text-sm ${msg.ok ? 'text-lime-neon' : 'text-rose-neon'}`}>{msg.text}</p>}
      </section>

      {form && (
        <section className="panel flex flex-col gap-3" data-ap-settings>
          <div className="panel-title"><span>What to watch</span></div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Coins">
            <span className="label mr-1 w-20">Coins</span>
            {symbols.map((c) => <button key={c} type="button" className="seg" data-ap-coin={c} aria-pressed={form.symbols.includes(c)} onClick={() => setForm((f) => ({ ...f, symbols: toggle(f.symbols, c) }))}>{baseOf(c)}</button>)}
          </div>
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Intervals">
            <span className="label mr-1 w-20">Intervals</span>
            {INTERVALS.map((v) => <button key={v} type="button" className="seg" data-ap-interval={v} aria-pressed={form.intervals.includes(v)} onClick={() => setForm((f) => ({ ...f, intervals: toggle(f.intervals, v) }))}>{v}</button>)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(cfg.data.conditions).map(([k, c]) => (
              <div key={k} className="flex items-center justify-between gap-2 rounded border border-ink-700 px-2 py-1.5 text-xs" data-ap-condition={k}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={Boolean(form.conditions[k]?.enabled)} onChange={(e) => setForm((f) => ({ ...f, conditions: { ...f.conditions, [k]: { ...f.conditions[k], enabled: e.target.checked } } }))} />
                  {c.label}
                </label>
                {c.threshold !== null && (
                  <label className="flex items-center gap-1 text-mute">
                    <input aria-label={`${c.label} threshold`} className="field num w-16 py-0.5" type="number" step="any" min={c.min} max={c.max} value={form.conditions[k]?.threshold ?? c.threshold} onChange={(e) => setForm((f) => ({ ...f, conditions: { ...f.conditions, [k]: { ...f.conditions[k], threshold: e.target.value } } }))} />
                    {c.unit}
                  </label>
                )}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1"><span className="label">Quiet from</span><input id="ap-quiet-start" type="time" className="field py-1" value={form.quietStart} onChange={(e) => setForm((f) => ({ ...f, quietStart: e.target.value }))} /></label>
            <label className="flex flex-col gap-1"><span className="label">Quiet until</span><input id="ap-quiet-end" type="time" className="field py-1" value={form.quietEnd} onChange={(e) => setForm((f) => ({ ...f, quietEnd: e.target.value }))} /></label>
            <label className="flex flex-col gap-1"><span className="label">Time zone</span><input id="ap-quiet-tz" className="field w-44 py-1" value={form.quietTimeZone} onChange={(e) => setForm((f) => ({ ...f, quietTimeZone: e.target.value }))} /></label>
            <label className="flex items-center gap-2 text-xs"><input id="ap-notify" type="checkbox" checked={form.notify} onChange={(e) => setForm((f) => ({ ...f, notify: e.target.checked }))} />Notify on this page</label>
            <button type="button" className="btn btn-cyan" data-ap-save disabled={Boolean(busy)} onClick={save}>Save settings</button>
          </div>
          <p className="text-[11px] text-mute">During quiet hours, findings are still saved but no notification is shown.</p>
        </section>
      )}

      <section className="panel flex flex-col gap-2" data-ap-events>
        <div className="panel-title"><span>Findings</span>{events.data?.unread > 0 && <button type="button" className="seg" data-ap-read onClick={() => act('read', () => api('/api/autopilot/events/read', { method: 'POST' }), 'Marked as read.')}>Mark {events.data.unread} as read</button>}</div>
        <Status loading={events.loading} error={events.error} data={events.data} what="findings" />
        {events.data && !events.data.events.length && <Empty>No findings yet. A finding appears when a watched condition starts on a closed candle.</Empty>}
        <ul className="divide-y divide-ink-700">
          {events.data?.events.map((e) => (
            <li key={e.id} className="flex flex-col gap-1 py-2" data-ap-event={e.id}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-slate-200">{baseOf(e.symbol)} · {e.interval}</span>
                <span className="text-xs text-mute">{cfg.data?.conditions[e.condition]?.label ?? e.condition}</span>
                {!e.read && <span className="rounded border border-cyan-neon/50 px-1 text-[10px] text-cyan-neon">NEW</span>}
                {e.suppressed_quiet && <span className="rounded border border-ink-600 px-1 text-[10px] text-mute">QUIET HOURS</span>}
              </div>
              <p className="text-sm text-slate-300">{e.explanation || e.message}</p>
              <p className="num text-[11px] text-mute">Candle closed {time(e.as_of)} · Recorded {time(e.created_at)} · {e.explanation_mode === 'ai' ? 'AI explanation' : 'Rule-based explanation, not AI'}</p>
              {e.context?.headlines?.length > 0 && <ul className="text-xs">{e.context.headlines.map((h) => <li key={h.link}><a className="text-cyan-neon underline" href={h.link} target="_blank" rel="noreferrer noopener">{h.title}</a> <span className="text-mute">{h.source}</span></li>)}</ul>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel flex flex-col gap-2" data-ap-runs>
        <div className="panel-title"><span>Activity log</span></div>
        <Status loading={runs.loading} error={runs.error} data={runs.data} what="the activity log" />
        {runs.data && !runs.data.length && <Empty>No checks have run yet.</Empty>}
        <ul className="divide-y divide-ink-700 text-xs">
          {runs.data?.map((r) => (
            <li key={r.id} className="py-1.5" data-ap-run-row={r.id}>
              <details>
                <summary className="cursor-pointer"><span className={r.status === 'ok' ? 'text-lime-neon' : r.status === 'running' ? 'text-mute' : 'text-amber-neon'}>{r.status}</span> <span className="num text-mute">{time(r.started_at)} · {r.trigger === 'schedule' ? 'scheduled' : 'manual'}</span> <span className="text-slate-300">{r.summary}</span></summary>
                <ol className="ml-4 mt-1 list-decimal text-mute">{r.steps.map((st, i) => { const { name, at, ...rest } = st; return <li key={i}>{name}: <span className="num">{Object.entries(rest).map(([k, v]) => `${k} ${v}`).join(', ')}</span></li>; })}</ol>
                {r.errors.length > 0 && <ul className="ml-4 mt-1 text-amber-neon">{r.errors.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              </details>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel flex flex-col gap-2" data-ap-audit>
        <div className="panel-title"><span>Audit log</span></div>
        <Status loading={audit.loading} error={audit.error} data={audit.data} what="the audit log" />
        {audit.data && !audit.data.length && <Empty>No changes recorded yet.</Empty>}
        <ul className="num divide-y divide-ink-700 text-xs">
          {audit.data?.map((a) => <li key={a.id} className="py-1" data-ap-audit-row>{time(a.at)} · {a.actor} · {a.action.replace(/_/g, ' ')}{a.detail?.changed ? `: ${Object.keys(a.detail.changed).join(', ')}` : ''}</li>)}
        </ul>
      </section>
    </div>
  );
}
