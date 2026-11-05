import { useState } from 'react';
import { api, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, AiBadge, Empty } from './common.jsx';

const SENT = { Positive: 'text-lime-neon', Negative: 'text-rose-neon', Neutral: 'text-mute' };

export default function News({ symbols }) {
  const [coin, setCoin] = useState('');
  const { data, error, loading } = useApi(`/api/news${coin ? `?symbol=${coin}` : ''}`, { every: 300000 });
  const [digest, setDigest] = useState(null);
  const [digestErr, setDigestErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(null);

  async function summarise() {
    setBusy(true); setDigest(null); setDigestErr('');
    try { setDigest(await api('/api/news/digest', { method: 'POST', body: { symbol: coin || undefined } })); }
    catch (e) { setDigestErr(e.message); }
    finally {
      setBusy(false);
      api('/api/intel/status').then((s) => setAi(s.ai)).catch(() => {});
    }
  }
  const aiNow = ai || data?.ai;

  return (
    <div className="flex flex-col gap-4" data-news>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>Crypto news</span><AiBadge ai={aiNow} /></div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter news by coin">
          <button type="button" className="seg" aria-pressed={!coin} onClick={() => setCoin('')}>All</button>
          {symbols.map((s) => <button key={s} type="button" data-news-coin={s} className="seg" aria-pressed={coin === s} onClick={() => setCoin(s)}>{baseOf(s)}</button>)}
        </div>
        {aiNow?.configured && (
          <div className="rounded border border-violet-neon/30 bg-violet-neon/5 p-3" data-digest>
            <div className="flex items-center justify-between gap-2">
              <span className="label text-violet-neon">AI-generated interpretation</span>
              <button type="button" className="btn btn-ghost py-1" disabled={busy} onClick={summarise}>{busy ? 'Writing…' : 'Summarise headlines'}</button>
            </div>
            {digestErr && <p role="alert" className="mt-1 text-xs text-rose-neon">{digestErr}</p>}
            {digest && <p className="mt-1 text-sm leading-relaxed text-slate-300">{digest.text}</p>}
            {digest && <p className="num mt-1 text-[10px] text-mute">{digest.model}. May be wrong; check the original articles.</p>}
          </div>
        )}
        <Status loading={loading} error={error} data={data} what="news" />
        {data?.sources.some((s) => !s.ok) && <p className="text-xs text-amber-neon">Couldn't read: {data.sources.filter((s) => !s.ok).map((s) => `${s.source} (${s.detail})`).join(', ')}.</p>}
        {data && !data.articles.length && <Empty>No recent article from these sources mentions {coin ? nameOf(coin) : 'a tracked coin'}.</Empty>}
        <ul className="flex flex-col divide-y divide-ink-700">
          {data?.articles.map((a) => (
            <li key={a.published.link} data-article className="py-2.5">
              <a href={a.published.link} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-slate-100 hover:text-cyan-neon hover:underline">{a.published.title}</a>
              <p className="num mt-0.5 text-[11px] text-mute">{a.published.source} · {time(a.published.publishedAt)}{a.coins.length > 0 && ` · ${a.coins.map(baseOf).join(', ')}`}</p>
              {a.published.summary && <p className="mt-1 text-xs leading-relaxed text-slate-300">{a.published.summary}</p>}
              <p className="mt-1 text-[11px] text-mute" data-interpretation>
                <span className="label mr-1">Automated estimate</span>
                Sentiment <span className={SENT[a.interpretation.sentiment]}>{a.interpretation.sentiment}</span> · Possible impact {a.interpretation.impact}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-relaxed text-mute">Headlines, summaries, times and links are as published by each source; Signal Lab hasn't fact-checked them. "Automated estimate" comes from keyword matching, not from AI or a verified assessment, and it often misses context.</p>
      </section>
    </div>
  );
}
