import { useState } from 'react';
import { api, fmt, pct, price, time, tone, usd } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Stat, StatGrid, AiBadge, Empty, Status } from './common.jsx';

const blankCondition = () => ({ left: { kind: 'indicator', name: 'rsi14' }, op: '>', right: { kind: 'value', value: 50 } });
const blankDraft = (symbol) => ({ name: 'New strategy', symbol, interval: '1h', entry: { logic: 'AND', conditions: [blankCondition()] }, exit: { logic: 'OR', conditions: [] }, stopLossPct: null, takeProfitPct: null, positionPct: 100 });
const SAMPLE = 'Buy BTC when RSI crosses above 30 and MACD shows a bullish crossover. Sell when RSI reaches 70 or the stop loss is triggered.';
const n2 = (v) => (v === null || v === undefined ? '—' : fmt(v, 2));

function ConditionRow({ c, schema, onChange, onRemove, id }) {
  const indicators = Object.entries(schema.indicators);
  return (
    <div className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1fr_1fr_100px_1fr_auto]" data-condition>
      <select aria-label="Indicator" className="field py-1 text-xs" value={c.left?.name ?? ''} onChange={(e) => onChange({ ...c, left: { kind: 'indicator', name: e.target.value } })}>
        {indicators.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select aria-label="Comparison" className="field py-1 text-xs" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })}>
        {Object.entries(schema.operators).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select aria-label="Compare with" className="field py-1 text-xs" value={c.right?.kind ?? 'value'} onChange={(e) => onChange({ ...c, right: e.target.value === 'value' ? { kind: 'value', value: 0 } : { kind: 'indicator', name: 'ema50' } })}>
        <option value="value">Number</option>
        <option value="indicator">Indicator</option>
      </select>
      {c.right?.kind === 'indicator' ? (
        <select aria-label="Second indicator" className="field py-1 text-xs" value={c.right.name} onChange={(e) => onChange({ ...c, right: { kind: 'indicator', name: e.target.value } })}>
          {indicators.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      ) : (
        <input aria-label="Value" id={id} className="field num py-1 text-xs" type="number" step="any" value={c.right?.value ?? ''} onChange={(e) => onChange({ ...c, right: { kind: 'value', value: e.target.value } })} />
      )}
      <button type="button" className="seg" onClick={onRemove}>Remove</button>
    </div>
  );
}

function Group({ label, group, schema, onChange, testId }) {
  const setCondition = (i, c) => onChange({ ...group, conditions: group.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="flex flex-col gap-2" data-group={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">{label}</span>
        {['AND', 'OR'].map((l) => <button key={l} type="button" className="seg" aria-pressed={group.logic === l} onClick={() => onChange({ ...group, logic: l })}>{l === 'AND' ? 'All must be true' : 'Any can be true'}</button>)}
        <button type="button" className="seg" onClick={() => onChange({ ...group, conditions: [...group.conditions, blankCondition()] })}>Add condition</button>
      </div>
      {!group.conditions.length && <p className="text-xs text-mute">No conditions.</p>}
      {group.conditions.map((c, i) => <ConditionRow key={i} id={`${testId}-value-${i}`} c={c} schema={schema} onChange={(v) => setCondition(i, v)} onRemove={() => onChange({ ...group, conditions: group.conditions.filter((_, j) => j !== i) })} />)}
    </div>
  );
}

function Results({ result }) {
  const m = result.metrics;
  return (
    <div className="flex flex-col gap-2" data-strategy-results>
      <p className="text-sm"><span className={`font-semibold ${result.ok ? 'text-lime-neon' : 'text-amber-neon'}`}>{result.verdict}.</span> <span className="text-slate-300">{result.detail}</span></p>
      <StatGrid className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Total return" value={pct(m.totalReturnPct)} className={tone(m.totalReturnPct)} />
        <Stat label="Buy & hold" value={pct(m.buyHoldReturnPct)} className={tone(m.buyHoldReturnPct)} />
        <Stat label="Out of sample" value={pct(result.outOfSample.totalReturnPct)} className={tone(result.outOfSample.totalReturnPct)} note={`${result.outOfSample.trades} trades`} />
        <Stat label="Win rate" value={m.winRatePct === null ? '—' : pct(m.winRatePct, 1, false)} />
        <Stat label="Max drawdown" value={`-${fmt(m.maxDrawdownPct, 1)}%`} />
        <Stat label="Profit factor" value={n2(m.profitFactor)} />
        <Stat label="Sharpe (ann.)" value={n2(m.sharpe)} />
        <Stat label="Trades" value={m.trades} />
        <Stat label="Fees" value={usd(m.feesPaid)} />
        <Stat label="Slippage" value={usd(m.slippagePaid)} />
      </StatGrid>
      <p className="num text-[11px] text-mute">{result.candlesUsed.toLocaleString()} closed {baseOf(result.symbol)} {result.interval} candles · {time(m.startTime)} → {time(m.endTime)} · {result.assumptions.execution}</p>
      {result.trades.length > 0 && (
        <details className="rounded border border-ink-700">
          <summary className="cursor-pointer px-3 py-2 text-xs text-mute">Trade list ({result.trades.length})</summary>
          <div className="max-h-56 overflow-auto">
            <table className="num w-full min-w-[560px] text-xs">
              <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="px-3 py-1 font-normal">Entry</th><th className="font-normal">Price</th><th className="font-normal">Exit</th><th className="font-normal">Price</th><th className="font-normal">Why</th><th className="font-normal">P&amp;L</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {[...result.trades].reverse().map((t) => <tr key={t.entryTime}><td className="px-3 py-1">{time(t.entryTime)}</td><td>{price(t.entryPrice)}</td><td>{time(t.exitTime)}</td><td>{price(t.exitPrice)}</td><td className="text-mute">{t.exitReason}</td><td className={tone(t.pnl)}>{usd(t.pnl)}</td></tr>)}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

/** Approved strategies can suggest a paper order. Nothing is placed without this explicit confirmation. */
function PaperPanel({ strategy }) {
  const [check, setCheck] = useState(null);
  const [amount, setAmount] = useState(500);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState(null);
  async function runCheck() {
    try { setCheck(await api(`/api/strategies/${strategy.id}/check`)); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  async function place(side, closeAll = false) {
    setMsg(null);
    try {
      const r = await api(`/api/strategies/${strategy.id}/paper-order`, { method: 'POST', body: { side, amountUsd: Number(amount), closeAll, confirmed: true } });
      setMsg({ ok: true, text: `${side === 'BUY' ? 'Bought' : 'Sold'} ${fmt(r.trade.qty, 6)} ${baseOf(r.trade.symbol)} at ${price(r.trade.fill_price)} on your paper account. It's recorded in the Trading journal.` });
      setConfirm(false);
      runCheck();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  }
  return (
    <div className="flex flex-col gap-2 rounded border border-violet-neon/30 bg-violet-neon/5 p-3" data-paper-panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label text-violet-neon">Paper trading · simulated, no real money</span>
        <button type="button" className="btn btn-ghost py-1" data-strategy-check onClick={runCheck}>Check latest candle</button>
      </div>
      {check && (
        <div className="text-xs" data-check-result>
          <p className="text-slate-200">{check.action === 'enter' ? 'Entry conditions are met.' : check.action === 'exit' ? 'Exit conditions are met.' : 'No action right now.'} <span className="num text-mute">{baseOf(strategy.config.symbol)} {price(check.price)}, candle closed {time(check.asOf)}. {check.holding ? 'You hold a position.' : 'You hold no position.'}</span></p>
        </div>
      )}
      <label className="flex items-center gap-2 text-xs text-slate-300"><input id="paper-confirm" type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I confirm this paper order</label>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2"><span className="label">USD</span><input id="strategy-paper-amount" className="field num w-24 py-1" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button type="button" className="btn btn-lime py-1" disabled={!confirm} onClick={() => place('BUY')}>Paper buy</button>
        <button type="button" className="btn btn-ghost py-1" disabled={!confirm} onClick={() => place('SELL', true)}>Paper close</button>
      </div>
      {msg && <p role="status" className={`text-xs ${msg.ok ? 'text-lime-neon' : 'text-rose-neon'}`}>{msg.text}</p>}
    </div>
  );
}

export default function StrategyBuilder({ symbols, symbol }) {
  const schema = useApi('/api/strategies/schema');
  const saved = useApi('/api/strategies');
  const [text, setText] = useState(SAMPLE);
  const [draft, setDraft] = useState(null);
  const [current, setCurrent] = useState(null); // the saved record being edited
  const [source, setSource] = useState(null);
  const [notes, setNotes] = useState({ warnings: [], errors: [], riskReward: null });
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [bars, setBars] = useState(1000);

  const set = (k) => (e) => { setDraft((d) => ({ ...d, [k]: e.target.value })); setCurrent((c) => (c ? { ...c, dirty: true } : c)); };
  const setValue = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setCurrent((c) => (c ? { ...c, dirty: true } : c)); };

  async function convert() {
    setBusy('convert'); setErr(''); setResult(null);
    try {
      const r = await api('/api/strategies/parse', { method: 'POST', body: { text, symbol } });
      setDraft({ ...r.draft, symbol: r.draft.symbol || symbol, interval: r.draft.interval || '1h' });
      setCurrent(null);
      setSource({ mode: r.mode, model: r.model, aiError: r.aiError });
      setNotes({ warnings: r.warnings, errors: r.errors, riskReward: r.riskReward });
    } catch (x) { setErr(x.message); }
    finally { setBusy(''); }
  }
  async function check() {
    const r = await api('/api/strategies/validate', { method: 'POST', body: { config: draft } });
    setNotes({ warnings: r.warnings, errors: r.errors, riskReward: r.riskReward });
    return r;
  }
  async function backtest() {
    setBusy('backtest'); setErr(''); setResult(null);
    try {
      const v = await check();
      if (v.errors.length) return;
      setResult(await api('/api/strategies/backtest', { method: 'POST', body: { config: draft, bars: Number(bars) } }));
    } catch (x) { setErr(x.message); }
    finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setErr('');
    try {
      const v = await check();
      if (v.errors.length) return;
      const row = current?.id
        ? await api(`/api/strategies/${current.id}`, { method: 'PUT', body: { config: draft } })
        : await api('/api/strategies', { method: 'POST', body: { config: draft, sourceText: text, sourceMode: source?.mode } });
      setCurrent(row);
      saved.reload();
    } catch (x) { setErr(x.message); }
    finally { setBusy(''); }
  }
  async function approve() {
    setErr('');
    try {
      setCurrent(await api(`/api/strategies/${current.id}/approve`, { method: 'POST' }));
      saved.reload();
    } catch (x) { setErr(x.message); }
  }
  async function remove(s) {
    await api(`/api/strategies/${s.id}`, { method: 'DELETE' });
    if (current?.id === s.id) { setCurrent(null); setDraft(null); }
    saved.reload();
  }
  const load = (s) => { setDraft(s.config); setCurrent(s); setResult(null); setSource(null); setNotes({ warnings: [], errors: [], riskReward: null }); };

  const sc = schema.data;
  if (!sc) return <section className="panel"><Status {...schema} what="the strategy builder" /></section>;
  const approved = current?.status === 'approved' && !current.dirty;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]" data-builder>
      <div className="flex min-w-0 flex-col gap-4">
        <section className="panel flex flex-col gap-3">
          <div className="panel-title"><span>Describe a strategy</span><AiBadge ai={sc.ai} /></div>
          <textarea id="strategy-text" aria-label="Strategy description" className="field min-h-[72px] text-sm" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" data-strategy-convert className="btn btn-cyan" disabled={busy === 'convert' || !text.trim()} onClick={convert}>{busy === 'convert' ? 'Reading…' : 'Convert to rules'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setDraft(blankDraft(symbol)); setCurrent(null); setSource(null); setResult(null); setNotes({ warnings: [], errors: [], riskReward: null }); }}>Start blank</button>
          </div>
          {source && <p data-strategy-source className="text-[11px] text-mute">{source.mode === 'ai' ? `Converted by AI (${source.model}), then checked by the validator.` : `Converted by the built-in rule reader, not AI.${source.aiError ? ` AI failed: ${source.aiError}` : ''}`} Review every rule below.</p>}
          <p className="text-[11px] text-mute">Text becomes a restricted set of rules: named indicators, fixed comparisons and numbers. Nothing from the text or an AI is ever run as code.</p>
        </section>

        {draft && (
          <section className="panel flex flex-col gap-4" data-editor>
            <div className="panel-title"><span>Rules</span>{current && <span data-strategy-status className={`rounded border px-2 py-0.5 text-[10px] ${approved ? 'border-lime-neon/50 text-lime-neon' : 'border-amber-neon/50 text-amber-neon'}`}>{approved ? 'APPROVED' : current.dirty ? 'EDITED, NOT SAVED' : 'DRAFT, NOT APPROVED'}</span>}</div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <label className="col-span-2 flex flex-col gap-1"><span className="label">Name</span><input id="strategy-name" className="field text-sm" maxLength={80} value={draft.name} onChange={set('name')} /></label>
              <label className="flex flex-col gap-1"><span className="label">Coin</span><select id="strategy-symbol" className="field" value={draft.symbol ?? ''} onChange={set('symbol')}><option value="">Choose</option>{symbols.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}</select></label>
              <label className="flex flex-col gap-1"><span className="label">Timeframe</span><select id="strategy-interval" className="field num" value={draft.interval} onChange={set('interval')}>{sc.intervals.map((i) => <option key={i}>{i}</option>)}</select></label>
              <label className="flex flex-col gap-1"><span className="label">Position % of equity</span><input id="strategy-position" className="field num" type="number" min="1" max="100" value={draft.positionPct} onChange={set('positionPct')} /></label>
              <div />
              <label className="flex flex-col gap-1"><span className="label">Stop loss %</span><input id="strategy-stop" className="field num" type="number" step="any" min="0.1" max="50" value={draft.stopLossPct ?? ''} onChange={(e) => setValue('stopLossPct', e.target.value === '' ? null : e.target.value)} /></label>
              <label className="flex flex-col gap-1"><span className="label">Take profit %</span><input id="strategy-target" className="field num" type="number" step="any" min="0.1" max="500" value={draft.takeProfitPct ?? ''} onChange={(e) => setValue('takeProfitPct', e.target.value === '' ? null : e.target.value)} /></label>
              <div className="flex flex-col justify-center"><span className="label">Risk / reward</span><span className="num text-sm" data-risk-reward>{Number(draft.stopLossPct) > 0 && Number(draft.takeProfitPct) > 0 ? `1 : ${(draft.takeProfitPct / draft.stopLossPct).toFixed(2)}` : '—'}</span></div>
            </div>
            <Group testId="entry" label="Entry" group={draft.entry} schema={sc} onChange={(g) => setValue('entry', g)} />
            <Group testId="exit" label="Exit" group={draft.exit} schema={sc} onChange={(g) => setValue('exit', g)} />
            {notes.errors.length > 0 && <ul role="alert" data-strategy-errors className="list-disc pl-4 text-xs text-rose-neon">{notes.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            {notes.warnings.length > 0 && <ul data-strategy-warnings className="list-disc pl-4 text-xs text-amber-neon">{notes.warnings.map((e) => <li key={e}>{e}</li>)}</ul>}
            {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2"><span className="label">Candles</span><select id="strategy-bars" className="field num py-1" value={bars} onChange={(e) => setBars(e.target.value)}>{[500, 1000, 2000, 3000, 5000].map((b) => <option key={b} value={b}>{b.toLocaleString()}</option>)}</select></label>
              <button type="button" data-strategy-backtest className="btn btn-cyan" disabled={busy === 'backtest'} onClick={backtest}>{busy === 'backtest' ? 'Testing…' : 'Backtest'}</button>
              <button type="button" data-strategy-save className="btn btn-ghost" disabled={busy === 'save'} onClick={save}>Save draft</button>
              <button type="button" data-strategy-approve className="btn btn-lime" disabled={!current?.id || current.dirty || approved} onClick={approve}>{approved ? 'Approved' : 'Approve for paper trading'}</button>
            </div>
            {result && <Results result={result} />}
            {approved && <PaperPanel strategy={current} />}
          </section>
        )}
      </div>
      <section className="panel h-fit" data-saved-strategies>
        <div className="panel-title"><span>Saved strategies</span></div>
        <Status {...saved} what="strategies" />
        {saved.data && !saved.data.length && <Empty>None yet.</Empty>}
        <ul className="flex flex-col divide-y divide-ink-700 text-xs">
          {saved.data?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 py-1.5">
              <button type="button" className="min-w-0 truncate text-left text-slate-200 hover:text-cyan-neon" onClick={() => load(s)}>{s.name}</button>
              <span className="flex shrink-0 items-center gap-1"><span className={s.status === 'approved' ? 'text-lime-neon' : 'text-mute'}>{s.status}</span><button type="button" className="seg py-0" onClick={() => remove(s)}>Delete</button></span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
