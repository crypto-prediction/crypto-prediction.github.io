import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmt, pct, price, usd, tone, time } from '../lib.js';
import { baseOf, nameOf, pairColor } from '../coins.js';
import { LineChart, C } from './Charts.jsx';
import { Pie } from './Insights.jsx';

const CASH_COLOR = '#5B6472';

export function PaperPanel({ symbol, livePrice }) {
  const [pf, setPf] = useState(null);
  const [trades, setTrades] = useState([]);
  const [eq, setEq] = useState([]);
  const [amount, setAmount] = useState(500);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, t, e] = await Promise.all([api('/api/paper/portfolio'), api('/api/paper/trades?limit=100'), api('/api/paper/equity')]);
      setPf(p); setTrades(t); setEq(e); setErr('');
    } catch (x) { setErr(x.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  async function order(side, closeAll = false) {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/paper/order', { method: 'POST', body: { symbol, side, amountUsd: Number(amount), closeAll } });
      const t = r.trade;
      setMsg({ ok: true, text: `${side === 'BUY' ? 'Bought' : 'Sold'} ${fmt(t.qty, 6)} ${baseOf(t.symbol)} at ${price(t.fill_price)} (market ${price(t.market_price)}, fee ${usd(t.fee)}${t.realized_pnl !== null ? `, P&L ${usd(t.realized_pnl)}` : ''}). Price from ${t.price_source}.` });
      setPf(r.portfolio);
      load();
    } catch (x) { setMsg({ ok: false, text: x.message }); }
    finally { setBusy(false); }
  }

  async function reset() {
    if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); return; }
    setConfirmReset(false);
    try { setPf(await api('/api/paper/reset', { method: 'POST' })); setMsg({ ok: true, text: 'Paper account reset to $10,000.' }); load(); }
    catch (x) { setMsg({ ok: false, text: x.message }); }
  }

  const eqSeries = useMemo(() => [{ data: eq.map((r) => ({ time: new Date(r.ts).getTime(), value: r.equity })), color: C.violet, width: 2 }], [eq]);
  const pos = pf?.positions.find((p) => p.symbol === symbol);
  // allocation needs every position priced: an unpriced one is reported, not guessed
  const allocation = pf && pf.allPositionsPriced ? [
    ...pf.positions.map((p) => ({ label: baseOf(p.symbol), value: p.marketValue, color: pairColor(p.symbol), display: usd(p.marketValue) })).sort((a, b) => b.value - a.value),
    { label: 'Cash', value: pf.cash, color: CASH_COLOR, display: usd(pf.cash) },
  ] : null;

  return (
    <section className="panel flex flex-col gap-4">
      <div className="panel-title">
        <span>Paper trading</span>
        <span className="rounded border border-violet-neon/50 px-2 py-0.5 text-[10px] text-violet-neon">SIMULATED · NO REAL MONEY</span>
      </div>
      <p className="-mt-2 text-[11px] text-mute">Orders fill at the live Binance price plus {pf?.slippageBps ?? 5} bps slippage and a {fmt(pf?.feeRatePct ?? 0.1, 2)}% fee. Nothing is sent to an exchange.</p>
      {err && <p role="alert" className="text-sm text-rose-neon">{err}</p>}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-ink-700 bg-ink-700 sm:grid-cols-3">
        {[
          ['Equity', pf?.equity === null ? 'needs live price' : usd(pf?.equity), ''],
          ['Total P&L', pf?.totalPnl === null ? '—' : `${usd(pf?.totalPnl)} (${pct(pf?.totalPnlPct)})`, tone(pf?.totalPnl)],
          ['Cash', usd(pf?.cash), ''],
          ['Realised P&L', usd(pf?.realizedPnl), tone(pf?.realizedPnl)],
          ['Fees paid', usd(pf?.feesPaid), ''],
          ['Win rate (closes)', pf?.winRatePct === null || pf?.winRatePct === undefined ? '—' : `${pct(pf.winRatePct, 0, false)} of ${pf.closedTrades}`, ''],
        ].map(([k, v, c]) => <div key={k} className="bg-ink-900 px-3 py-2"><div className="label">{k}</div><div className={`num text-sm sm:text-base ${c}`}>{v}</div></div>)}
      </div>

      <div className="rounded border border-ink-700 p-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-display text-sm font-bold">{nameOf(symbol)} <span className="text-mute">{baseOf(symbol)}/USDT</span></span>
          <span className="num text-sm">{livePrice ? `Live ${price(livePrice)}` : <span className="text-amber-neon">No live price</span>}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="label">USD</span>
            <input id="paper-amount" className="field num w-28" type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <button className="btn btn-lime" disabled={busy} onClick={() => order('BUY')}>Buy</button>
          <button className="btn btn-rose" disabled={busy || !pos} onClick={() => order('SELL')}>Sell</button>
          <button className="btn btn-ghost" disabled={busy || !pos} onClick={() => order('SELL', true)}>Close position</button>
        </div>
        {msg && <p role="status" className={`mt-2 text-xs ${msg.ok ? 'text-lime-neon' : 'text-rose-neon'}`}>{msg.text}</p>}
      </div>

      <div data-allocation>
        <div className="label mb-1">Portfolio allocation</div>
        {allocation ? (
          <Pie slices={allocation} center={usd(pf.equity, 0)} centerLabel="equity" valueLabel="Value" caption="Paper portfolio allocation" />
        ) : <p className="text-sm text-amber-neon">{pf ? 'Waiting for a live price on every position.' : 'Loading…'}</p>}
      </div>

      <div>
        <div className="label mb-1">Open positions</div>
        {!pf?.positions.length ? <p className="text-sm text-mute">No open positions. Buy above to open one at the live price.</p> : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-xs">
              <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Pair</th><th className="font-normal">Qty</th><th className="font-normal">Avg entry</th><th className="font-normal">Live</th><th className="font-normal">Value</th><th className="font-normal">Unrealised</th><th className="font-normal">Realised</th><th className="font-normal">Fees</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {pf.positions.map((p) => (
                  <tr key={p.symbol}><td className="py-1.5">{baseOf(p.symbol)}</td><td>{fmt(p.qty, 6)}</td><td>{price(p.avgPrice)}</td><td>{p.livePrice === null ? <span className="text-amber-neon">unavailable</span> : price(p.livePrice)}</td><td>{usd(p.marketValue)}</td><td className={tone(p.unrealizedPnl)}>{p.unrealizedPnl === null ? '—' : `${usd(p.unrealizedPnl)} (${pct(p.unrealizedPct)})`}</td><td className={tone(p.realizedPnl)}>{usd(p.realizedPnl)}</td><td>{usd(p.feesPaid)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pf?.closedCoins?.length > 0 && (
        <div>
          <div className="label mb-1">Closed coins</div>
          <table className="num w-full text-xs">
            <thead className="text-left text-mute"><tr><th className="py-1 font-normal">Coin</th><th className="font-normal">Trades</th><th className="font-normal">Realised</th><th className="font-normal">Fees</th></tr></thead>
            <tbody className="divide-y divide-ink-700">
              {pf.closedCoins.map((c) => <tr key={c.symbol}><td className="py-1">{baseOf(c.symbol)}</td><td>{c.trades}</td><td className={tone(c.realizedPnl)}>{usd(c.realizedPnl)}</td><td>{usd(c.feesPaid)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}

      {eq.length > 1 && <div><div className="label mb-1">Account equity (recorded each minute and after each trade)</div><LineChart series={eqSeries} height={150} /></div>}

      <div>
        <div className="label mb-1">Trade history</div>
        {!trades.length ? <p className="text-sm text-mute">No paper trades yet.</p> : (
          <div className="max-h-64 overflow-auto">
            <table className="num w-full min-w-[720px] text-xs">
              <thead className="sticky top-0 bg-ink-900 text-left text-mute"><tr><th className="py-1 font-normal">Time</th><th className="font-normal">Side</th><th className="font-normal">Qty</th><th className="font-normal">Market</th><th className="font-normal">Fill</th><th className="font-normal">Entry</th><th className="font-normal">Fee</th><th className="font-normal">P&amp;L</th><th className="font-normal">Source</th></tr></thead>
              <tbody className="divide-y divide-ink-700">
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="py-1">{time(new Date(t.created_at).getTime())}</td>
                    <td className={t.side === 'BUY' ? 'text-lime-neon' : 'text-rose-neon'}>{t.side} {baseOf(t.symbol)}</td>
                    <td>{fmt(t.qty, 6)}</td><td>{price(t.market_price)}</td><td>{price(t.fill_price)}</td>
                    <td>{t.entry_price === null ? '—' : price(t.entry_price)}</td><td>{usd(t.fee)}</td>
                    <td className={tone(t.realized_pnl)}>{t.realized_pnl === null ? '—' : usd(t.realized_pnl)}</td>
                    <td className="text-mute">{t.price_source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex justify-end"><button className="btn btn-ghost" onClick={reset}>{confirmReset ? 'Tap again to reset' : 'Reset paper account'}</button></div>
    </section>
  );
}
