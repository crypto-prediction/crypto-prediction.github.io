import { useCallback, useEffect, useRef, useState } from 'react';
import { api, compact, fmt, pct, price, time, tone, usd } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid } from './common.jsx';

export default function Exchanges({ symbol, symbols, onSelect }) {
  const cfg = useApi('/api/exchanges/config');
  const [tradeUsd, setTradeUsd] = useState(1000);
  const [withdrawal, setWithdrawal] = useState(0);
  const [fees, setFees] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!cfg.data || fees) return;
    setFees(Object.fromEntries(Object.entries(cfg.data.exchanges).map(([id, e]) => [id, e.takerFeePct])));
    setChosen(Object.keys(cfg.data.exchanges));
  }, [cfg.data, fees]);

  const load = useCallback(async () => {
    if (!fees || !chosen) return;
    const id = ++latest.current;
    setBusy(true);
    try {
      const r = await api('/api/exchanges/compare', { method: 'POST', body: { symbol, tradeUsd: Number(tradeUsd), withdrawalFeeUsd: Number(withdrawal), feesPct: fees, exchanges: chosen } });
      if (id === latest.current) { setData(r); setErr(''); }
    } catch (e) { if (id === latest.current) setErr(e.message); }
    finally { if (id === latest.current) setBusy(false); }
  }, [symbol, tradeUsd, withdrawal, fees, chosen]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const o = data?.opportunity;
  return (
    <div className="flex flex-col gap-4" data-exchanges>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Choose a coin">
        {symbols.map((s) => <button key={s} type="button" data-x-coin={s} className="seg" aria-pressed={symbol === s} onClick={() => onSelect(s)}>{baseOf(s)}</button>)}
      </div>
      <section className="panel flex flex-col gap-3">
        <div className="panel-title"><span>{nameOf(symbol)} across exchanges</span><span className="num font-normal normal-case tracking-normal text-mute">{data ? `Updated ${time(data.fetchedAt)}` : busy ? 'Loading…' : ''}</span></div>
        <Status loading={cfg.loading} error={cfg.error} data={cfg.data} what="the exchange list" />
        {cfg.data && fees && chosen && (
          <div className="flex flex-col gap-3" data-x-controls>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Exchanges">
              <span className="label mr-1">Exchanges</span>
              {Object.entries(cfg.data.exchanges).map(([id, e]) => <button key={id} type="button" data-x-exchange={id} className="seg" aria-pressed={chosen.includes(id)} onClick={() => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}>{e.name}</button>)}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1"><span className="label">Trade size, USD</span><input id="x-trade" className="field num w-28 py-1" type="number" min="1" value={tradeUsd} onChange={(e) => setTradeUsd(e.target.value)} /></label>
              <label className="flex flex-col gap-1"><span className="label">Withdrawal fee, USD</span><input id="x-withdrawal" className="field num w-28 py-1" type="number" min="0" step="any" value={withdrawal} onChange={(e) => setWithdrawal(e.target.value)} /></label>
              {Object.entries(cfg.data.exchanges).map(([id, e]) => <label key={id} className="flex flex-col gap-1"><span className="label">{e.name} fee %</span><input data-x-fee={id} className="field num w-20 py-1" type="number" min="0" max="5" step="any" value={fees[id]} onChange={(ev) => setFees((f) => ({ ...f, [id]: ev.target.value }))} /></label>)}
            </div>
            {data && <p className="text-[11px] text-amber-neon">{data.feeNote} Public APIs don't give withdrawal fees without an account, so enter yours or the result below leaves them out.</p>}
          </div>
        )}
        {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}
        {data && (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[900px] text-xs" data-x-table>
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Exchange</th><th className="font-normal">Last</th><th className="font-normal">Bid</th><th className="font-normal">Ask</th><th className="font-normal">Spread</th><th className="font-normal">vs {data.referenceExchange}</th><th className="font-normal">Difference</th><th className="font-normal">24h volume</th><th className="font-normal">Bids / asks within 0.5%</th><th className="font-normal">Cost to buy, incl. fee</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {data.rows.map((r) => (
                  <tr key={r.id} data-x-row={r.id}>
                    <td className="py-1 font-semibold">{r.name}{r.converted ? ' *' : ''}</td>
                    {r.error ? <td colSpan={9} className="text-amber-neon">{r.error === 'Not listed' ? `${baseOf(symbol)} is not listed here` : `Unavailable: ${r.error}`}</td> : (
                      <>
                        <td>{r.last === null ? '—' : price(r.last)}</td><td>{r.bid === null ? '—' : price(r.bid)}</td><td>{r.ask === null ? '—' : price(r.ask)}</td>
                        <td>{r.spreadBps === null ? '—' : `${fmt(r.spreadBps, 2)} bps`}</td>
                        <td className={tone(r.diffPct)}>{r.diffPct === undefined ? '—' : pct(r.diffPct, 3)}</td>
                        <td className={tone(r.diffUsdt)}>{r.diffUsdt === undefined ? '—' : r.name === data.referenceExchange ? 'Reference' : `${r.diffUsdt > 0 ? '+' : ''}${fmt(r.diffUsdt, Math.abs(r.diffUsdt) >= 1 ? 2 : 6)}`}</td>
                        <td>{r.volumeUsd === null ? '—' : `$${compact(r.volumeUsd)}`}</td>
                        <td>{r.liquidity ? `$${compact(r.liquidity.bidUsd)} / $${compact(r.liquidity.askUsd)}` : '—'}</td>
                        <td>{r.buyCostPct === null ? '—' : `${fmt(r.buyCostPct, 3)}%${r.buy.complete ? '' : ' (book too thin)'}`}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.usdtUsd && <p className="num text-[11px] text-mute">* Quoted in USD and converted at the live USDT/USD rate of {fmt(data.usdtUsd, 5)} from Coinbase. All other prices are USDT.</p>}
      </section>

      {o && (
        <section className="panel flex flex-col gap-3" data-x-opportunity>
          <div className="panel-title"><span>Theoretical difference after costs</span><span className="rounded border border-amber-neon/50 px-2 py-0.5 text-[10px] text-amber-neon">NOT A GUARANTEED PROFIT</span></div>
          <StatGrid>
            <Stat label="Buy on" value={o.buyAt} note={`Ask ${price(o.buyPrice)}`} />
            <Stat label="Sell on" value={o.sellAt} note={`Bid ${price(o.sellPrice)}`} />
            <Stat label="Gross difference" value={pct(o.grossPct, 3)} className={tone(o.grossPct)} />
            <Stat label="Fees" value={`-${fmt(o.feePct, 3)}%`} />
            <Stat label="Slippage + withdrawal" value={`-${fmt(o.slippagePct + o.withdrawalPct, 3)}%`} note={o.fillsCompletely ? 'Visible books can fill this size' : 'A visible book is too thin for this size'} />
            <Stat label="Net, theoretical" value={pct(o.netPct, 3)} className={tone(o.netPct)} note={`${usd(o.netUsd)} on ${usd(o.tradeUsd, 0)}`} />
          </StatGrid>
          <p className="text-sm text-slate-300" data-x-caveat>{data.caveat}</p>
          {o.networkMinutes && <p className="text-[11px] text-mute">Rough network time to confirm a {data.base} transfer: {o.networkMinutes} minutes, and exchanges often take longer. Prices can move a lot in that time.</p>}
        </section>
      )}
    </div>
  );
}
