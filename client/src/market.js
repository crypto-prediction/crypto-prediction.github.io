// Shared market data for the globe, the selector and the insight charts.
import { useEffect, useState } from 'react';
import { api } from './lib.js';

const REFRESH_MS = 60000;

// Real candles for every coin at one interval, without indicators to keep the payload small.
// A failed refresh keeps the last real data and reports the error; nothing is ever filled in.
export function useMarketSeries(symbols, interval) {
  const [state, setState] = useState({ series: [], interval, error: '', fetchedAt: null });
  const symbolKey = symbols.join(',');

  useEffect(() => {
    if (!symbolKey) return undefined;
    let cancelled = false;
    const limit = window.innerWidth < 700 ? 300 : 500;
    const syms = symbolKey.split(',');
    setState({ series: [], interval, error: '', fetchedAt: null });

    const load = async () => {
      const results = await Promise.allSettled(syms.map((s) => api(`/api/candles?symbol=${s}&interval=${interval}&limit=${limit}&indicators=0`)));
      if (cancelled) return;
      const series = results.flatMap((r, i) => (r.status === 'fulfilled' ? [{ symbol: syms[i], candles: r.value.candles }] : []));
      const missing = syms.filter((_, i) => results[i].status === 'rejected');
      const error = missing.length ? `No data for ${missing.join(', ')}` : '';
      setState((prev) => (series.length === syms.length || !prev.series.length
        ? { series, interval, error, fetchedAt: series.length ? Date.now() : null }
        : { ...prev, error }));
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [symbolKey, interval]);

  return state;
}

// Each coin's trend, RSI, MACD and signal, keyed by symbol.
export function useOverview(ready, interval) {
  const [state, setState] = useState({ coins: {}, interval, error: '', loading: true });

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    setState({ coins: {}, interval, error: '', loading: true });
    const load = async () => {
      try {
        const r = await api(`/api/overview?interval=${interval}`);
        if (!cancelled) setState({ coins: Object.fromEntries(r.coins.map((c) => [c.symbol, c])), interval, error: '', loading: false });
      } catch (e) {
        if (!cancelled) setState((prev) => ({ ...prev, error: e.message, loading: false }));
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [ready, interval]);

  return state;
}
