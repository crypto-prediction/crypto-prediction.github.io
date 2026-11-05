// Market activity from sources that actually report it. Exchange order-book data and on-chain data
// are kept in separate fields and never mixed. Anything without a reliable source says "not connected".

const BTC_LARGE = 100; // BTC, for a transfer to count as large
const SATS = 1e8;

/** Depth, spread and imbalance from a Binance order book within band (fraction of mid price). */
export function summarizeBook(book, band = 0.01) {
  const bids = book.bids.map(([p, q]) => [Number(p), Number(q)]);
  const asks = book.asks.map(([p, q]) => [Number(p), Number(q)]);
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const within = (rows, test) => rows.filter(([p]) => test(p)).reduce((s, [p, q]) => s + p * q, 0);
  const bidDepth = within(bids, (p) => p >= mid * (1 - band));
  const askDepth = within(asks, (p) => p <= mid * (1 + band));
  const biggest = (rows) => rows.reduce((best, r) => (r[0] * r[1] > best[0] * best[1] ? r : best), rows[0]);
  const [wallBidP, wallBidQ] = biggest(bids);
  const [wallAskP, wallAskQ] = biggest(asks);
  return {
    mid,
    spreadBps: ((asks[0][0] - bids[0][0]) / mid) * 1e4,
    bidDepthUsd: bidDepth,
    askDepthUsd: askDepth,
    imbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0,
    largestBid: { price: wallBidP, usd: wallBidP * wallBidQ },
    largestAsk: { price: wallAskP, usd: wallAskP * wallAskQ },
    bandPct: band * 100,
  };
}

/** Candles whose move is far outside the coin's own recent range of moves. */
export function suddenMoves(candles, { lookback = 96, threshold = 3 } = {}) {
  const closed = candles.filter((c) => c.closed !== false);
  if (closed.length < lookback + 1) return [];
  const window = closed.slice(-lookback - 1);
  const rets = window.slice(1).map((c, i) => c.close / window[i].close - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
  if (!sd) return [];
  return rets.flatMap((r, i) => (Math.abs(r - m) / sd >= threshold ? [{ time: window[i + 1].closeTime, movePct: r * 100, sigmas: Math.abs(r - m) / sd }] : [])).slice(-3);
}

/** Large transfers in a sample of unconfirmed Bitcoin transactions. */
export function largeBtcTransfers(payload, minBtc = BTC_LARGE) {
  return (payload?.txs || []).flatMap((tx) => {
    const btc = (tx.out || []).reduce((s, o) => s + (o.value || 0), 0) / SATS;
    return btc >= minBtc ? [{ hash: tx.hash, btc, time: tx.time ? tx.time * 1000 : null }] : [];
  }).sort((a, b) => b.btc - a.btc);
}

export function createActivity({ rest, cached, overviewFor, historyFor, markets, fetchImpl = globalThis.fetch }) {
  const lastBooks = new Map();

  async function orderBook(symbol) {
    return cached(`book:${symbol}`, 5000, async () => {
      const summary = summarizeBook(await rest.request('/api/v3/depth', { symbol, limit: 100 }));
      if (!summary) return null;
      const prev = lastBooks.get(symbol);
      lastBooks.set(symbol, { summary, at: Date.now() });
      return {
        ...summary,
        fetchedAt: Date.now(),
        change: prev ? { imbalance: summary.imbalance - prev.summary.imbalance, bidDepthPct: (summary.bidDepthUsd / prev.summary.bidDepthUsd - 1) * 100, askDepthPct: (summary.askDepthUsd / prev.summary.askDepthUsd - 1) * 100, sinceMs: Date.now() - prev.at } : null,
      };
    });
  }

  async function bitcoinOnChain() {
    return cached('onchain:btc', 60000, async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetchImpl('https://blockchain.info/unconfirmed-transactions?format=json', { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return { status: 'connected', source: 'blockchain.info', sampleSize: data.txs?.length ?? 0, minBtc: BTC_LARGE, transfers: largeBtcTransfers(data).slice(0, 10), fetchedAt: Date.now() };
      } catch (e) {
        return { status: 'error', source: 'blockchain.info', detail: e.message, transfers: [], minBtc: BTC_LARGE };
      } finally {
        clearTimeout(timer);
      }
    }).catch((e) => ({ status: 'error', source: 'blockchain.info', detail: e.message, transfers: [], minBtc: BTC_LARGE }));
  }

  async function report(symbol) {
    const [overview, book, btc] = await Promise.all([overviewFor('1h'), orderBook(symbol), bitcoinOnChain()]);
    const moves = await Promise.all(markets.active().map(async (s) => {
      try {
        return { symbol: s, moves: suddenMoves(await historyFor(s, '15m')) };
      } catch {
        return { symbol: s, moves: [] };
      }
    }));
    return {
      symbol,
      exchange: {
        source: 'Binance spot (exchange data, not on-chain)',
        orderBook: book,
        unusualVolume: overview.filter((c) => c.relativeVolume >= 2).map((c) => ({ symbol: c.symbol, relativeVolume: c.relativeVolume })),
        suddenMoves: moves.filter((m) => m.moves.length),
      },
      onChain: {
        bitcoin: btc,
        otherChains: { status: 'not-connected', detail: 'No reliable keyless source is connected for the other coins, so no on-chain data is shown for them.' },
        exchangeFlows: { status: 'not-connected', detail: 'Exchange inflows and outflows need a paid provider that labels exchange wallets. None is connected, so none are shown.' },
      },
    };
  }

  return { report, orderBook };
}
