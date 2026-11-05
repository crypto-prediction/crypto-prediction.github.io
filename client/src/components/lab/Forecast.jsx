import { useState } from 'react';
import { price } from '../../format.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Empty } from './common.jsx';

const HORIZONS = ['15m', '1h', '4h', '24h', '7d'];
const DIR = { Up: 'text-lime-neon', Down: 'text-rose-neon', Sideways: 'text-amber-neon' };
const p0 = (v) => `${(v * 100).toFixed(1)}%`;

function Card({ f }) {
  if (f.unavailable) {
    return <div className="rounded border border-ink-700 bg-ink-900 p-3 text-xs" data-forecast={f.symbol}><div className="font-display text-sm font-bold">{baseOf(f.symbol)}</div><p className="mt-1 text-amber-neon">No forecast: {f.unavailable}</p></div>;
  }
  const h = f.holdout;
  return (
    <div className="flex flex-col gap-2 rounded border border-ink-700 bg-ink-900 p-3 text-xs" data-forecast={f.symbol}>
      <div className="flex items-baseline justify-between">
        <span className="font-display text-sm font-bold">{nameOf(f.symbol)} <span className="font-normal text-mute">{baseOf(f.symbol)}</span></span>
        <span className={`font-display text-sm font-bold ${DIR[f.direction]}`}>{f.direction}</span>
      </div>
      <div>
        <div className="num flex justify-between"><span className="text-lime-neon">Up {p0(f.probabilityUp)}</span><span className="text-rose-neon">Down {p0(f.probabilityDown)}</span></div>
        <div className="mt-1 flex h-1.5 gap-0.5" role="img" aria-label={`Probability up ${p0(f.probabilityUp)}`}>
          <div className="rounded-l bg-lime-neon" style={{ width: `${f.probabilityUp * 100}%` }} />
          <div className="flex-1 rounded-r bg-rose-neon" />
        </div>
      </div>
      <dl className="num grid grid-cols-2 gap-x-3 gap-y-0.5">
        <dt className="text-mute">Now</dt><dd className="text-right">{price(f.price)}</dd>
        <dt className="text-mute">{f.range.coverage}% range</dt><dd className="text-right">{price(f.range.low)} – {price(f.range.high)}</dd>
        <dt className="text-mute">Support</dt><dd className="text-right">{f.support === null ? 'none found' : price(f.support)}</dd>
        <dt className="text-mute">Resistance</dt><dd className="text-right">{f.resistance === null ? 'none found' : price(f.resistance)}</dd>
        <dt className="text-mute">Expected volatility</dt><dd className="text-right">±{f.expectedVolatilityPct.toFixed(2)}%</dd>
        <dt className="text-mute">Risk vs its norm</dt><dd className="text-right">{f.riskLevel}</dd>
        <dt className="text-mute">Confidence</dt><dd className="text-right">{f.confidence}</dd>
      </dl>
      <div>
        <div className="label">Why</div>
        <ul className="mt-0.5">
          {f.reasons.map((r) => <li key={r.label} className="flex justify-between gap-2"><span className="text-slate-300">{r.label} <span className="num text-mute">{r.reading}</span></span><span className={r.pushes === 'up' ? 'text-lime-neon' : 'text-rose-neon'}>{r.pushes}</span></li>)}
        </ul>
      </div>
      <p className="border-t border-ink-700 pt-1.5 text-[11px] text-mute">
        {h
          ? <>On held-out past data: {(h.accuracy * 100).toFixed(1)}% direction accuracy, about {h.independentSamples} independent periods, Brier {h.brier.toFixed(3)} vs {h.baselineBrier.toFixed(3)} baseline. {f.hasMeasuredEdge ? 'A small measured edge.' : <span className="text-amber-neon">No measured edge over the baseline.</span>}</>
          : <span className="text-amber-neon">Too little history to measure skill.</span>}
      </p>
    </div>
  );
}

export default function Forecast() {
  const [horizon, setHorizon] = useState('24h');
  const { data, error, loading } = useApi(`/api/forecast?horizon=${horizon}`, { every: 60000 });
  const status = useApi('/api/intel/status');
  return (
    <section className="panel flex flex-col gap-3" data-forecast-tab>
      <div className="panel-title">
        <span>Forecasting engine</span>
        {status.data && <span data-model-status className="rounded border border-ink-600 px-2 py-0.5 font-normal normal-case tracking-normal text-mute">Running: {status.data.forecasting.model} (statistical, not AI)</span>}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Forecast horizon">
        {HORIZONS.map((h) => <button key={h} type="button" data-horizon={h} className="seg num" aria-pressed={horizon === h} onClick={() => setHorizon(h)}>{h}</button>)}
      </div>
      <Status loading={loading} error={error} data={data} what="forecasts" />
      {data && !data.forecasts.length && <Empty>No forecasts available.</Empty>}
      {data && <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">{data.forecasts.map((f) => <Card key={f.symbol} f={f} />)}</div>}
      <p className="text-[11px] leading-relaxed text-mute">
        A logistic regression trained on each coin's own past candles and indicators, using only candles that have closed. Its probability is pulled toward the coin's base rate according to how well it did on later past data, so most readings sit near 50%, which is the honest result for a hard problem. Confidence stays Low unless it beat a simple baseline on at least 20 independent held-out periods. {data?.disclaimer}
      </p>
    </section>
  );
}
