import { useEffect, useState } from 'react';
import { api, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Empty } from './common.jsx';

const INTERVALS = ['15m', '1h', '4h', '1d'];

function describe(rule, types, metrics) {
  const p = rule.params || {};
  const label = types?.[rule.type]?.label || rule.type;
  if (rule.type === 'custom') return `${metrics?.[p.metric] || p.metric} ${p.op} ${p.value}`;
  if (rule.type === 'forecast_change') return `${label} (${p.horizon})`;
  return p.value !== undefined ? `${label}: ${p.value}` : label;
}

export default function Alerts({ symbols, symbol, onAlertsRead, lastAlert }) {
  const meta = useApi('/api/intel/status');
  const rules = useApi('/api/alerts/rules');
  const events = useApi('/api/alerts/events?limit=100');
  const [form, setForm] = useState({ symbol, type: 'price_above', interval: '1h', value: '', metric: 'rsi', op: '>', horizon: '24h', cooldownMin: 60 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const types = meta.data?.alertTypes;
  const metrics = meta.data?.customMetrics;
  const def = types?.[form.type];
  const needsValue = def && (def.needs.includes('value') || def.defaults.value !== undefined);

  useEffect(() => { api('/api/alerts/events/read', { method: 'POST' }).then(onAlertsRead).catch(() => {}); }, [onAlertsRead, lastAlert]);
  useEffect(() => { if (lastAlert) events.reload(); }, [lastAlert]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    const params = {};
    if (needsValue) params.value = form.value === '' ? def.defaults.value : form.value;
    if (form.type === 'custom') { params.metric = form.metric; params.op = form.op; }
    if (form.type === 'forecast_change') params.horizon = form.horizon;
    try {
      await api('/api/alerts/rules', { method: 'POST', body: { symbol: form.symbol, type: form.type, interval: form.interval, params, cooldownMin: Number(form.cooldownMin) } });
      setForm((f) => ({ ...f, value: '' }));
      rules.reload();
    } catch (x) { setErr(x.message); }
    finally { setBusy(false); }
  }
  const toggle = async (r) => { await api(`/api/alerts/rules/${r.id}`, { method: 'PATCH', body: { enabled: !r.enabled } }); rules.reload(); };
  const remove = async (r) => { await api(`/api/alerts/rules/${r.id}`, { method: 'DELETE' }); rules.reload(); };

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" data-alerts>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Create an alert</span></div>
        <form onSubmit={create} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1"><span className="label">Coin</span>
            <select id="alert-symbol" className="field" value={form.symbol} onChange={set('symbol')}>{symbols.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}</select></label>
          <label className="col-span-2 flex flex-col gap-1"><span className="label">Condition</span>
            <select id="alert-type" className="field" value={form.type} onChange={set('type')}>{types && Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
          {form.type === 'custom' && (
            <>
              <label className="flex flex-col gap-1"><span className="label">Metric</span>
                <select id="alert-metric" className="field" value={form.metric} onChange={set('metric')}>{metrics && Object.entries(metrics).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label className="flex flex-col gap-1"><span className="label">Is</span>
                <select id="alert-op" className="field num" value={form.op} onChange={set('op')}>{['>', '>=', '<', '<='].map((o) => <option key={o}>{o}</option>)}</select></label>
            </>
          )}
          {needsValue && (
            <label className="flex flex-col gap-1"><span className="label">Value</span>
              <input id="alert-value" className="field num" type="number" step="any" value={form.value} placeholder={def.defaults.value !== undefined ? String(def.defaults.value) : ''} onChange={set('value')} /></label>
          )}
          {form.type === 'forecast_change' ? (
            <label className="flex flex-col gap-1"><span className="label">Horizon</span>
              <select id="alert-horizon" className="field num" value={form.horizon} onChange={set('horizon')}>{(meta.data?.horizons || []).map((h) => <option key={h}>{h}</option>)}</select></label>
          ) : (
            <label className="flex flex-col gap-1"><span className="label">Candles</span>
              <select id="alert-interval" className="field num" value={form.interval} onChange={set('interval')}>{INTERVALS.map((i) => <option key={i}>{i}</option>)}</select></label>
          )}
          <label className="flex flex-col gap-1"><span className="label">Quiet period (min)</span>
            <input id="alert-cooldown" className="field num" type="number" min="1" max="10080" value={form.cooldownMin} onChange={set('cooldownMin')} /></label>
          <div className="col-span-2 flex items-end sm:col-span-3"><button className="btn btn-cyan" disabled={busy}>{busy ? 'Saving…' : 'Add alert'}</button></div>
        </form>
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
        <div>
          <div className="label mb-1">Your alerts</div>
          <Status {...rules} what="alerts" />
          {rules.data && !rules.data.length && <Empty>No alerts yet. Nothing is being checked until you add one.</Empty>}
          <ul className="divide-y divide-ink-700 text-xs">
            {rules.data?.map((r) => (
              <li key={r.id} data-rule={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className={r.enabled ? 'text-slate-200' : 'text-mute'}><strong>{baseOf(r.symbol)}</strong> {describe(r, types, metrics)} <span className="num text-mute">{r.type === 'forecast_change' ? '' : r.interval}</span></span>
                <span className="flex gap-1">
                  <button type="button" className="seg" aria-pressed={r.enabled} onClick={() => toggle(r)}>{r.enabled ? 'On' : 'Off'}</button>
                  <button type="button" className="seg" onClick={() => remove(r)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[11px] leading-relaxed text-mute">Alerts are checked on the server every 30 seconds, so they keep running with this page closed, for as long as the server is running. Anything that fires while you're away appears here and on the Lab button when you return. There are no phone, email or desktop notifications. A rule fires when its condition becomes true, not on every check, and won't repeat within its quiet period.</p>
      </section>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Alert history</span></div>
        <Status {...events} what="alert history" />
        {events.data && !events.data.events.length && <Empty>No alert has fired yet.</Empty>}
        <ul className="max-h-[520px] divide-y divide-ink-700 overflow-auto text-xs">
          {events.data?.events.map((e) => <li key={e.id} data-event={e.id} className="py-1.5"><span className="num text-mute">{time(new Date(e.created_at).getTime())}</span> <span className="text-slate-200">{e.message}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
