import { time, price } from '../../lib.js';
import { baseOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

const pc = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const br = (v) => (v === null || v === undefined ? '—' : v.toFixed(3));

function Breakdown({ title, rows, name = (k) => k }) {
  const keys = Object.keys(rows);
  return (
    <div>
      <div className="label mb-1">{title}</div>
      {!keys.length ? <Empty>No scored forecasts yet.</Empty> : (
        <div className="overflow-x-auto">
          <table className="num w-full min-w-[440px] text-xs">
            <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Group</th><th className="font-normal">Scored</th><th className="font-normal">Accuracy</th><th className="font-normal">Precision</th><th className="font-normal">Recall</th><th className="font-normal">Brier</th></tr></thead>
            <tbody className="divide-y divide-ink-700">
              {keys.map((k) => <tr key={k}><td className="py-1">{name(k)}</td><td>{rows[k].n}</td><td>{pc(rows[k].accuracy)}</td><td>{pc(rows[k].precisionUp)}</td><td>{pc(rows[k].recallUp)}</td><td>{br(rows[k].brier)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Tracker() {
  const { data, error, loading } = useApi('/api/forecast/performance', { every: 60000 });
  const o = data?.overall;
  return (
    <section className="panel flex flex-col gap-4" data-tracker>
      <div className="panel-title"><span>Model performance tracker</span><span className="font-normal normal-case tracking-normal text-mute">Saved forecasts compared with the prices that followed</span></div>
      <Status loading={loading} error={error} data={data} what="model performance" />
      {data && (
        <>
          <StatGrid>
            <Stat label="Forecasts saved" value={data.saved} note={data.first_saved ? `since ${time(new Date(data.first_saved).getTime())}` : 'none yet'} />
            <Stat label="Waiting for outcome" value={data.pending} />
            <Stat label="Scored" value={o.n} />
            <Stat label="Direction accuracy" value={pc(o.accuracy)} note={`${o.directionalCalls} up/down calls`} />
            <Stat label="Brier score" value={br(o.brier)} note="0.25 is coin-flip level" />
            <Stat label="Range coverage" value={pc(o.rangeCoverage)} note="aim: 80%" />
          </StatGrid>
          {o.n < data.minimumForJudgement && (
            <p data-tracker-warning className="rounded border border-amber-neon/40 bg-amber-neon/10 px-3 py-2 text-xs text-amber-neon">
              {o.n === 0 ? 'No forecast has reached its target time yet, so there is no accuracy to report.' : `Only ${o.n} scored forecasts. At least ${data.minimumForJudgement} are needed before these numbers mean much.`} Longer horizons take up to 7 days to score.
            </p>
          )}
          <div>
            <div className="label mb-1">Calibration: when the model said X%, how often did price rise?</div>
            <div className="overflow-x-auto">
              <table className="num w-full min-w-[380px] text-xs">
                <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Predicted up</th><th className="font-normal">Scored</th><th className="font-normal">Average predicted</th><th className="font-normal">Actually rose</th></tr></thead>
                <tbody className="divide-y divide-ink-700">
                  {data.calibration.map((b) => <tr key={b.from}><td className="py-1">{(b.from * 100).toFixed(0)}–{(b.to * 100).toFixed(0)}%</td><td>{b.n}</td><td>{pc(b.meanPredicted)}</td><td>{pc(b.observedUp)}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <Breakdown title="By cryptocurrency" rows={data.byCoin} name={baseOf} />
            <Breakdown title="By timeframe" rows={data.byHorizon} />
            <Breakdown title="By market when forecast" rows={data.byMarket} />
          </div>
          <div>
            <div className="label mb-1">Latest scored forecasts</div>
            {!data.recent.length ? <Empty>None yet.</Empty> : (
              <div className="max-h-64 overflow-auto">
                <table className="num w-full min-w-[620px] text-xs">
                  <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Horizon</th><th className="font-normal">Called</th><th className="font-normal">P(up)</th><th className="font-normal">From</th><th className="font-normal">To</th><th className="font-normal">Rose?</th><th className="font-normal">Forecast at</th></tr></thead>
                  <tbody className="divide-y divide-ink-700">
                    {data.recent.map((r) => <tr key={`${r.symbol}${r.horizon}${r.as_of}`}><td className="py-1">{baseOf(r.symbol)}</td><td>{r.horizon}</td><td>{r.direction}</td><td>{pc(r.probability_up)}</td><td>{price(r.reference_price)}</td><td>{price(r.actual_price)}</td><td>{r.outcome_up ? 'Yes' : 'No'}</td><td>{time(new Date(r.as_of).getTime())}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="text-[11px] text-mute">Accuracy counts Up and Down calls only. Precision and recall are for the Up class. Forecasts are saved every 5 minutes while the server runs, one per coin, horizon and closed candle, so neighbouring forecasts overlap and aren't fully independent.</p>
        </>
      )}
    </section>
  );
}
