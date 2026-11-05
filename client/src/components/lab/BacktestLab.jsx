import { useMemo, useState } from 'react';
import { api, fmt, pct, tone, usd, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Empty } from './common.jsx';

const PERIODS = [
  { key: 'l1', label: 'Latest 1,000', bars: 1000, skip: 0 },
  { key: 'p1', label: 'Prior 1,000', bars: 1000, skip: 1000 },
  { key: 'l3', label: 'Latest 3,000', bars: 3000, skip: 0 },
];
const INTERVALS = ['15m', '1h', '4h', '1d'];
const SORTS = [['totalReturnPct', 'Return'], ['maxDrawdownPct', 'Drawdown'], ['sharpe', 'Sharpe'], ['trades', 'Trades']];

const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
const n2 = (v) => (v === null || v === undefined ? '—' : fmt(v, 2));
const verdictTone = (ok) => (ok ? 'text-lime-neon' : 'text-amber-neon');

function Multi({ label, options, value, onChange, testId }) {
  return (
    <div data-multi={testId}>
      <div className="label mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map(([k, text]) => <button key={k} type="button" className="seg" aria-pressed={value.includes(k)} onClick={() => onChange(toggle(value, k))}>{text}</button>)}
      </div>
    </div>
  );
}

function WalkForward({ symbols, strategies, symbol }) {
  const [form, setForm] = useState({ symbol, strategy: 'ema_cross', interval: '1h', bars: 2000, folds: 4 });
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  async function run(e) {
    e.preventDefault();
    setBusy(true); setErr(''); setRes(null);
    try { setRes(await api('/api/lab/walkforward', { method: 'POST', body: { ...form, bars: Number(form.bars), folds: Number(form.folds) } })); }
    catch (x) { setErr(x.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="panel flex flex-col gap-3" data-walkforward>
      <div className="panel-title"><span>Walk-forward validation</span></div>
      <form onSubmit={run} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="flex flex-col gap-1"><span className="label">Coin</span><select id="wf-symbol" className="field" value={form.symbol} onChange={set('symbol')}>{symbols.map((s) => <option key={s} value={s}>{nameOf(s)}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="label">Strategy</span><select id="wf-strategy" className="field" value={form.strategy} onChange={set('strategy')}>{Object.entries(strategies).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="label">Candles</span><select id="wf-interval" className="field num" value={form.interval} onChange={set('interval')}>{INTERVALS.map((i) => <option key={i}>{i}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="label">History</span><select id="wf-bars" className="field num" value={form.bars} onChange={set('bars')}>{[1000, 2000, 3000, 5000].map((b) => <option key={b} value={b}>{b.toLocaleString()}</option>)}</select></label>
        <label className="flex flex-col gap-1"><span className="label">Folds</span><input id="wf-folds" className="field num" type="number" min="2" max="8" value={form.folds} onChange={set('folds')} /></label>
        <div className="flex items-end"><button className="btn btn-cyan" disabled={busy}>{busy ? 'Validating…' : 'Run'}</button></div>
      </form>
      <p className="text-[11px] text-mute">Each fold chooses its settings using only earlier candles, then trades the next unseen stretch with fees and slippage. This shows whether a strategy survives on data it wasn't tuned on.</p>
      {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
      {res && (
        <>
          <p className="text-sm" data-wf-verdict><span className={`font-semibold ${verdictTone(res.ok)}`}>{res.verdict}.</span> <span className="text-slate-300">{res.detail}</span></p>
          <p className="num text-xs text-slate-300">{baseOf(res.symbol)} combined out-of-sample return <span className={tone(res.totalReturnPct)}>{pct(res.totalReturnPct)}</span> vs buy and hold <span className={tone(res.buyHoldReturnPct)}>{pct(res.buyHoldReturnPct)}</span> · {res.trades} trades · {res.foldsPositive} of {res.folds.length} folds positive · fees {usd(res.feesPaid)} · slippage {usd(res.slippagePaid)}</p>
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[680px] text-xs">
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Fold</th><th className="font-normal">Test period</th><th className="font-normal">Settings chosen</th><th className="font-normal">Training return</th><th className="font-normal">Test return</th><th className="font-normal">Buy & hold</th><th className="font-normal">Trades</th><th className="font-normal">Max DD</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {res.folds.map((f) => <tr key={f.fold}><td className="py-1">{f.fold}</td><td>{time(f.startTime)} → {time(f.endTime)}</td><td>{Object.entries(f.chosenParams).map(([k, v]) => `${k} ${v}`).join(', ') || 'defaults'}</td><td className={tone(f.trainReturnPct)}>{pct(f.trainReturnPct)}</td><td className={tone(f.testReturnPct)}>{pct(f.testReturnPct)}</td><td className={tone(f.buyHoldReturnPct)}>{pct(f.buyHoldReturnPct)}</td><td>{f.trades}</td><td>-{fmt(f.maxDrawdownPct, 1)}%</td></tr>)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default function BacktestLab({ symbols, symbol, meta }) {
  const strategies = meta?.strategies || {};
  const status = useApi('/api/intel/status');
  const [coins, setCoins] = useState(symbols);
  const [picked, setPicked] = useState(['ema_cross']);
  const [intervals, setIntervals] = useState(['1h']);
  const [periods, setPeriods] = useState(['l1']);
  const [feePct, setFeePct] = useState(0.1);
  const [slip, setSlip] = useState(5);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState('totalReturnPct');
  const combos = coins.length * picked.length * intervals.length * periods.length;
  const cap = status.data?.lab.maxCombinations ?? 120;

  async function run(e) {
    e.preventDefault();
    setBusy(true); setErr(''); setRes(null);
    try {
      setRes(await api('/api/lab/compare', { method: 'POST', body: { symbols: coins, strategies: picked, intervals, periods: PERIODS.filter((p) => periods.includes(p.key)).map(({ bars, skip }) => ({ bars, skip })), feePct, slippageBps: slip } }));
    } catch (x) { setErr(x.message); }
    finally { setBusy(false); }
  }
  const rows = useMemo(() => {
    if (!res) return [];
    return [...res.results].sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));
  }, [res, sort]);
  const periodName = (r) => PERIODS.find((p) => p.bars === r.bars && p.skip === r.skip)?.label ?? `${r.bars}`;

  return (
    <div className="flex flex-col gap-4" data-backtest-lab>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Strategy comparison</span><span className="font-normal normal-case tracking-normal text-mute">Real Binance history · filled at the next candle's open, so no look-ahead</span></div>
        <form onSubmit={run} className="flex flex-col gap-3">
          <Multi testId="coins" label="Coins" options={symbols.map((s) => [s, baseOf(s)])} value={coins} onChange={setCoins} />
          <Multi testId="strategies" label="Strategies" options={Object.entries(strategies).map(([k, v]) => [k, v.label])} value={picked} onChange={setPicked} />
          <Multi testId="intervals" label="Timeframes" options={INTERVALS.map((i) => [i, i])} value={intervals} onChange={setIntervals} />
          <Multi testId="periods" label="Historical periods (candles)" options={PERIODS.map((p) => [p.key, p.label])} value={periods} onChange={setPeriods} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1"><span className="label">Fee % per fill</span><input id="lab-fee" className="field num w-24" type="number" step="0.01" min="0" max="1" value={feePct} onChange={(e) => setFeePct(Number(e.target.value))} /></label>
            <label className="flex flex-col gap-1"><span className="label">Slippage bps</span><input id="lab-slip" className="field num w-24" type="number" step="1" min="0" max="100" value={slip} onChange={(e) => setSlip(Number(e.target.value))} /></label>
            <button className="btn btn-cyan" disabled={busy || !combos || combos > cap}>{busy ? 'Testing…' : `Run ${combos} ${combos === 1 ? 'test' : 'tests'}`}</button>
            {combos > cap && <span className="text-xs text-amber-neon">The limit is {cap} tests. Choose fewer options.</span>}
          </div>
        </form>
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
        {res && (
          <>
            <div className="flex flex-wrap items-center gap-1 text-xs"><span className="label">Sort by</span>{SORTS.map(([k, l]) => <button key={k} type="button" className="seg" aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>)}</div>
            <div className="overflow-x-auto">
              <table className="num w-full min-w-[1040px] text-xs" data-compare-table>
                <thead className="text-left text-mute"><tr>{['Coin', 'Strategy', 'TF', 'Period', 'Return', 'Buy & hold', 'Out-of-sample', 'Win rate', 'Max DD', 'Profit factor', 'Sharpe', 'Trades', 'Fees', 'Slippage', 'Reading'].map((h) => <th key={h} className="py-1 pr-2 font-normal">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {rows.map((r) => (
                    <tr key={`${r.symbol}${r.strategy}${r.interval}${r.bars}${r.skip}`}>
                      <td className="py-1 pr-2">{baseOf(r.symbol)}</td><td className="pr-2">{strategies[r.strategy]?.label}</td><td className="pr-2">{r.interval}</td><td className="pr-2">{periodName(r)}</td>
                      {r.error ? <td colSpan={11} className="text-amber-neon">{r.error}</td> : (
                        <>
                          <td className={`pr-2 ${tone(r.totalReturnPct)}`}>{pct(r.totalReturnPct)}</td>
                          <td className={`pr-2 ${tone(r.buyHoldReturnPct)}`}>{pct(r.buyHoldReturnPct)}</td>
                          <td className={`pr-2 ${tone(r.outOfSample.totalReturnPct)}`}>{pct(r.outOfSample.totalReturnPct)}</td>
                          <td className="pr-2">{r.winRatePct === null ? '—' : pct(r.winRatePct, 1, false)}</td>
                          <td className="pr-2">-{fmt(r.maxDrawdownPct, 1)}%</td>
                          <td className="pr-2">{n2(r.profitFactor)}</td>
                          <td className="pr-2">{n2(r.sharpe)}</td>
                          <td className="pr-2">{r.trades}</td>
                          <td className="pr-2">{usd(r.feesPaid)}</td>
                          <td className="pr-2">{usd(r.slippagePaid)}</td>
                          <td className={verdictTone(r.ok)} title={r.detail}>{r.verdict}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <Empty>No results.</Empty>}
            <p className="text-[11px] text-mute">Each row starts with $10,000. A strategy needs at least {res.minimumTrades} trades before it gets any verdict beyond "Insufficient trades". "Held up in this test" is the strongest reading available, and it's about this past period only. Testing many combinations also makes a lucky result more likely.</p>
          </>
        )}
      </section>
      <WalkForward symbols={symbols} strategies={strategies} symbol={symbol} />
    </div>
  );
}
