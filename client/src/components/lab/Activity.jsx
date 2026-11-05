import { compact, fmt, pct, price, time } from '../../lib.js';
import { baseOf, nameOf } from '../../coins.js';
import { useApi, Status, Stat, StatGrid, Empty } from './common.jsx';

export default function Activity({ symbol, symbols, onSelect }) {
  const { data: d, error, loading } = useApi(`/api/activity?symbol=${symbol}`, { every: 15000 });
  const book = d?.exchange.orderBook;
  const btc = d?.onChain.bitcoin;
  return (
    <div className="flex flex-col gap-4" data-activity>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Choose a coin">
        {symbols.map((s) => <button key={s} type="button" data-activity-coin={s} className="seg" aria-pressed={symbol === s} onClick={() => onSelect(s)}>{baseOf(s)}</button>)}
      </div>
      <Status loading={loading} error={error} data={d} what="market activity" />
      {d && (
        <>
          <section className="panel flex flex-col gap-3" data-exchange-activity>
            <div className="panel-title"><span>Exchange activity · {nameOf(symbol)}</span><span className="rounded border border-cyan-neon/50 px-2 py-0.5 text-[10px] text-cyan-neon">BINANCE ORDER BOOK, NOT ON-CHAIN</span></div>
            {!book ? <Empty>The order book is unavailable right now.</Empty> : (
              <>
                <StatGrid>
                  <Stat label="Spread" value={`${fmt(book.spreadBps, 2)} bps`} />
                  <Stat label={`Bids within ${book.bandPct}%`} value={`$${compact(book.bidDepthUsd)}`} note={book.change ? `${pct(book.change.bidDepthPct)} since last` : ''} />
                  <Stat label={`Asks within ${book.bandPct}%`} value={`$${compact(book.askDepthUsd)}`} note={book.change ? `${pct(book.change.askDepthPct)} since last` : ''} />
                  <Stat label="Imbalance" value={fmt(book.imbalance, 2)} note="-1 asks to +1 bids" />
                  <Stat label="Largest bid" value={`$${compact(book.largestBid.usd)}`} note={`at ${price(book.largestBid.price)}`} />
                  <Stat label="Largest ask" value={`$${compact(book.largestAsk.usd)}`} note={`at ${price(book.largestAsk.price)}`} />
                </StatGrid>
                <p className="text-[11px] text-mute">Top 100 price levels per side, so depth is partial, and resting orders can be cancelled at any time. Refreshes every 15 seconds while this tab is open.</p>
              </>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <div className="label mb-1">Unusual volume (1h candles)</div>
                {d.exchange.unusualVolume.length
                  ? <ul className="text-sm text-slate-300">{d.exchange.unusualVolume.map((u) => <li key={u.symbol}>{baseOf(u.symbol)}: <span className="num">{fmt(u.relativeVolume, 2)}×</span> its 20-candle average</li>)}</ul>
                  : <Empty>No coin has a closed candle at 2× its average volume.</Empty>}
              </div>
              <div>
                <div className="label mb-1">Sudden price moves (15m candles, last 24h)</div>
                {d.exchange.suddenMoves.length
                  ? <ul className="text-sm text-slate-300">{d.exchange.suddenMoves.flatMap((c) => c.moves.map((m) => <li key={`${c.symbol}${m.time}`}>{baseOf(c.symbol)} <span className="num">{pct(m.movePct)}</span> <span className="num text-mute">{time(m.time)} · {fmt(m.sigmas, 1)}σ</span></li>))}</ul>
                  : <Empty>No 15-minute move beyond 3 standard deviations.</Empty>}
              </div>
            </div>
          </section>

          <section className="panel flex flex-col gap-3" data-onchain-activity>
            <div className="panel-title"><span>On-chain activity</span><span className="rounded border border-violet-neon/50 px-2 py-0.5 text-[10px] text-violet-neon">BLOCKCHAIN DATA, NOT EXCHANGE</span></div>
            <div>
              <div className="label mb-1">Bitcoin: large unconfirmed transfers</div>
              {btc.status === 'connected' ? (
                <>
                  {btc.transfers.length
                    ? <ul className="num text-xs text-slate-300">{btc.transfers.map((t) => <li key={t.hash} className="flex flex-wrap justify-between gap-2 py-0.5"><span>{fmt(t.btc, 2)} BTC</span><a className="truncate text-cyan-neon hover:underline" href={`https://www.blockchain.com/explorer/transactions/btc/${t.hash}`} target="_blank" rel="noopener noreferrer">{t.hash.slice(0, 16)}…</a></li>)}</ul>
                    : <Empty>No transfer of {btc.minBtc} BTC or more in the latest sample of {btc.sampleSize} unconfirmed transactions.</Empty>}
                  <p className="mt-1 text-[11px] text-mute">From {btc.source}: a small sample of unconfirmed transactions, so it will miss most large transfers. Output totals include change returned to the sender, so a transfer can look bigger than the amount actually sent, and it doesn't show who owns the wallets.</p>
                </>
              ) : <p className="text-sm text-amber-neon">Could not read {btc.source}: {btc.detail}. Nothing is shown in its place.</p>}
            </div>
            <div data-not-connected>
              <div className="label mb-1">Other coins</div>
              <p className="text-sm text-amber-neon">Not connected. {d.onChain.otherChains.detail}</p>
            </div>
            <div data-not-connected>
              <div className="label mb-1">Exchange inflows and outflows</div>
              <p className="text-sm text-amber-neon">Not connected. {d.onChain.exchangeFlows.detail}</p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
