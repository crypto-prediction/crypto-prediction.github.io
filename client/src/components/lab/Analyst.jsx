import { useState } from 'react';
import { api, pct } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, AiBadge, Empty } from './common.jsx';

const TREND = { Uptrend: 'text-lime-neon', Downtrend: 'text-rose-neon' };

function Chat({ symbol, onStatus }) {
  const presets = [`Why is ${baseOf(symbol)} moving?`, 'Which cryptocurrency has the strongest momentum?', 'Which coins show unusual activity?', 'Is the market bullish, bearish or neutral?', 'What are the current market risks?'];
  const [question, setQuestion] = useState('');
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  async function ask(q) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setQuestion('');
    try {
      const r = await api('/api/intel/chat', { method: 'POST', body: { question: text } });
      setLog((l) => [{ q: text, ...r }, ...l]);
      onStatus(r.ai);
    } catch (e) {
      setLog((l) => [{ q: text, error: e.message }, ...l]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel flex flex-col gap-3" data-chat>
      <div className="panel-title"><span>Analyst chat</span></div>
      <div className="flex flex-wrap gap-1">
        {presets.map((p) => <button key={p} type="button" className="seg text-left" disabled={busy} onClick={() => ask(p)}>{p}</button>)}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ask(question); }}>
        <input id="chat-question" aria-label="Ask about the market" className="field min-w-0 flex-1" maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about the market" />
        <button className="btn btn-cyan" disabled={busy || !question.trim()}>{busy ? 'Reading the market…' : 'Ask'}</button>
      </form>
      {log.map((m, i) => (
        <div key={log.length - i} className="rounded border border-ink-700 p-3 text-sm" data-answer={m.mode || 'error'}>
          <p className="text-xs text-mute">{m.q}</p>
          {m.error ? <p role="alert" className="mt-1 text-rose-neon">{m.error}</p> : <p className="mt-1 leading-relaxed text-slate-200">{m.answer}</p>}
          {!m.error && <p className="mt-1 text-[11px] text-mute">{m.mode === 'ai' ? `Written by AI (${m.model}) from live readings.` : `Rule-based answer from live readings, not AI.${m.aiError ? ` AI failed: ${m.aiError}` : ''}`}</p>}
        </div>
      ))}
    </section>
  );
}

export default function Analyst({ symbol }) {
  const { data, error, loading } = useApi('/api/intel/brief', { every: 60000 });
  const [ai, setAi] = useState(null);
  const b = data;
  return (
    <div className="flex flex-col gap-4" data-analyst>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Market intelligence</span><AiBadge ai={ai || b?.ai} /></div>
        <Status loading={loading} error={error} data={data} what="the market brief" />
        {b && (
          <>
            <StatGrid className="grid-cols-2 sm:grid-cols-4">
              <Stat label="Market reads" value={b.mood} className={b.mood === 'Bullish' ? 'text-lime-neon' : b.mood === 'Bearish' ? 'text-rose-neon' : 'text-amber-neon'} />
              <Stat label="Uptrend / downtrend" value={`${b.breadth.up} / ${b.breadth.down}`} note={`${b.breadth.mixed} mixed, 1h candles`} />
              <Stat label="Average 24h change" value={pct(b.averageChangePct)} />
              <Stat label="Strongest momentum" value={b.strongestMomentum[0] ? baseOf(b.strongestMomentum[0].symbol) : '—'} note={b.strongestMomentum[0] ? pct(b.strongestMomentum[0].momentumPct) : ''} />
            </StatGrid>
            <p className="text-xs text-mute">{b.moodBasis}</p>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <div className="label mb-1">Current risks</div>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-slate-300">{b.risks.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
              <div>
                <div className="label mb-1">Unusual activity</div>
                {b.unusualActivity.length
                  ? <ul className="flex flex-col gap-1 text-sm text-slate-300">{b.unusualActivity.map((u) => <li key={u.symbol}><span className="font-semibold">{baseOf(u.symbol)}</span>: {u.flags.join(', ')}</li>)}</ul>
                  : <Empty>No coin is past the thresholds: volume at 2× its average, or a 24h move of 8%.</Empty>}
              </div>
            </div>
            <div>
              <div className="label mb-1">Multi-timeframe trend</div>
              <div className="overflow-x-auto">
                <table className="num w-full min-w-[420px] text-xs">
                  <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">1h</th><th className="font-normal">4h</th><th className="font-normal">1d</th></tr></thead>
                  <tbody className="divide-y divide-ink-700">
                    {b.multiTimeframe.map((m) => (
                      <tr key={m.symbol}><td className="py-1">{nameOf(m.symbol)}</td>{['1h', '4h', '1d'].map((tf) => <td key={tf} className={TREND[m.trends[tf]] || 'text-mute'}>{m.trends[tf] ?? '—'}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
      <Chat symbol={symbol} onStatus={setAi} />
    </div>
  );
}
