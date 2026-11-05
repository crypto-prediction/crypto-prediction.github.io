import { useMemo, useState } from 'react';
import { api } from '../../lib.js';
import { useApi, Status, Empty } from './common.jsx';

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your browser time';
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const IMPORTANCE_STYLE = { high: 'border-rose-neon/60 text-rose-neon', medium: 'border-amber-neon/60 text-amber-neon', low: 'border-ink-600 text-mute', holiday: 'border-violet-neon/60 text-violet-neon' };

/** The day an event belongs to in the viewer's time zone. Date-only events keep their published date. */
const localDay = (e) => (e.starts_at ? dayKey(new Date(e.starts_at)) : e.event_date);
const whenLocal = (e) => (e.starts_at ? new Date(e.starts_at).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : `${e.event_date}, time not published`);
const whenUtc = (e) => (e.starts_at ? `${new Date(e.starts_at).toISOString().slice(11, 16)} UTC` : '');

function Importance({ level }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${IMPORTANCE_STYLE[level] || IMPORTANCE_STYLE.low}`}>{level}</span>;
}

function EventRow({ event, labels }) {
  const [why, setWhy] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const explain = async () => {
    setBusy(true);
    setErr('');
    try { setWhy(await api(`/api/calendar/${event.id}/explain`, { method: 'POST' })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col gap-1 py-2" data-cal-event={event.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Importance level={event.importance} />
        <span className="text-sm font-semibold text-slate-200">{event.title}</span>
        <span className="text-xs text-mute">{labels?.[event.category] || event.category}</span>
      </div>
      <div className="num text-xs text-mute">
        {whenLocal(event)}{event.starts_at ? ` (${whenUtc(event)})` : ''} · {event.country || '—'}{event.currency ? ` / ${event.currency}` : ''}
      </div>
      <div className="num text-xs text-slate-300" data-cal-values>
        Previous {event.previous ?? '—'} · Forecast {event.forecast ?? '—'} · Actual {event.actual ?? '—'}
        {event.actual_source && <span className="text-mute"> ({event.actual_source})</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <a className="text-cyan-neon underline" href={event.source_url} target="_blank" rel="noreferrer noopener">Source: {event.source}</a>
        <button type="button" className="text-cyan-neon underline" data-cal-explain onClick={explain} disabled={busy}>{busy ? 'Loading…' : 'Why it might matter'}</button>
      </div>
      {err && <p role="alert" className="text-xs text-rose-neon">{err}</p>}
      {why && (
        <p className="text-xs text-slate-300" data-cal-why>
          {why.text} <span className="text-mute">{why.note}{why.mode === 'background' ? ' Written background, not AI.' : ''}</span>
          {why.aiError && <span className="text-amber-neon"> AI unavailable: {why.aiError}</span>}
        </p>
      )}
    </li>
  );
}

function MonthGrid({ month, events, selected, onPick }) {
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array(first.getDay()).fill(null), ...Array.from({ length: count }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  }, [month]);
  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) (map[localDay(e)] ||= []).push(e);
    return map;
  }, [events]);
  const today = dayKey(new Date());
  return (
    <div className="grid grid-cols-7 gap-px overflow-hidden rounded border border-ink-700 bg-ink-700" data-cal-month>
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="label bg-ink-900 px-1 py-1 text-center">{d}</div>)}
      {cells.map((d, i) => {
        if (!d) return <div key={`blank-${i}`} className="bg-ink-900" />;
        const key = dayKey(d);
        const list = byDay[key] || [];
        const high = list.filter((e) => e.importance === 'high').length;
        return (
          <button key={key} type="button" data-cal-day={key} aria-pressed={selected === key} aria-label={`${key}: ${list.length} events, ${high} high importance`} onClick={() => onPick(selected === key ? null : key)}
            className={`min-h-[52px] bg-ink-900 p-1 text-left align-top ${selected === key ? 'outline outline-1 outline-cyan-neon' : ''}`}>
            <div className={`num text-xs ${key === today ? 'font-bold text-cyan-neon' : 'text-mute'}`}>{d.getDate()}</div>
            {list.length > 0 && <div className="num text-[10px] text-slate-300">{list.length}</div>}
            {high > 0 && <div className="num text-[10px] text-rose-neon">{high} high</div>}
          </button>
        );
      })}
    </div>
  );
}

export default function Calendar() {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [level, setLevel] = useState('high,medium');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState(null);
  // a day either side, so events near a month edge land right in any time zone
  const from = dayKey(new Date(month.getFullYear(), month.getMonth(), 0));
  const to = dayKey(new Date(month.getFullYear(), month.getMonth() + 1, 1));
  const q = new URLSearchParams({ from, to });
  if (level) q.set('importance', level);
  if (category) q.set('category', category);
  const { data, error, loading } = useApi(`/api/calendar?${q}`, { every: 300000 });
  const up = useApi('/api/calendar?importance=high,medium');

  const events = data?.events || [];
  const nowMs = Date.now();
  const upcoming = (up.data?.events || []).filter((e) => (e.starts_at ? new Date(e.starts_at).getTime() >= nowMs : e.event_date >= dayKey(new Date()))).slice(0, 12);
  const shown = selected ? events.filter((e) => localDay(e) === selected) : events.filter((e) => localDay(e).slice(0, 7) === dayKey(month).slice(0, 7));
  const move = (by) => { setSelected(null); setMonth((m) => new Date(m.getFullYear(), m.getMonth() + by, 1)); };

  return (
    <div className="flex flex-col gap-4" data-calendar>
      <p className="text-xs text-amber-neon" data-cal-timezone>Times are shown in your time zone, {LOCAL_ZONE}, with UTC beside them. {data?.timezone}</p>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Upcoming events</span></div>
        <Status loading={up.loading} error={up.error} data={up.data} what="upcoming events" />
        {up.data && !upcoming.length && <Empty>No upcoming high or medium importance events are listed by the connected sources.</Empty>}
        <ul className="divide-y divide-ink-700" data-cal-upcoming>{upcoming.map((e) => <EventRow key={e.id} event={e} labels={up.data?.categories} />)}</ul>
      </section>

      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
          <span className="flex gap-1">
            <button type="button" className="seg" data-cal-prev onClick={() => move(-1)}>Previous</button>
            <button type="button" className="seg" data-cal-next onClick={() => move(1)}>Next</button>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1"><span className="label">Importance</span>
            <select id="cal-level" className="field py-1" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="high">High</option><option value="high,medium">High and medium</option><option value="">All</option>
            </select>
          </label>
          <label className="flex flex-col gap-1"><span className="label">Type</span>
            <select id="cal-category" className="field py-1" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All types</option>
              {Object.entries(data?.categories || up.data?.categories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <Status loading={loading} error={error} data={data} what="the calendar" />
        <MonthGrid month={month} events={events} selected={selected} onPick={setSelected} />
        <h3 className="label">{selected ? `Events on ${selected}` : 'All events this month'}</h3>
        {data && !shown.length && <Empty>Nothing listed for this selection. That means the connected sources have nothing saved here, not that nothing is happening.</Empty>}
        <ul className="divide-y divide-ink-700" data-cal-list>{shown.slice(0, 150).map((e) => <EventRow key={e.id} event={e} labels={data?.categories} />)}</ul>
      </section>

      {data && (
        <section className="panel flex flex-col gap-2" data-cal-sources>
          <div className="panel-title"><span>Sources</span></div>
          <p className="text-xs text-mute">{data.coverage}</p>
          <ul className="flex flex-col gap-1 text-xs">
            {data.sources.map((s) => (
              <li key={s.name} data-cal-source={s.ok ? 'ok' : s.needsKey ? 'key' : 'failed'} className={s.ok ? 'text-slate-300' : 'text-amber-neon'}>
                {s.name}: {s.ok ? `${s.count} items read` : s.needsKey ? 'not connected' : 'failed'}{s.detail ? `. ${s.detail}` : ''}
              </li>
            ))}
            {data.notConnected.map((s) => <li key={s.name} className="text-amber-neon">{s.name}: not connected. {s.detail}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
