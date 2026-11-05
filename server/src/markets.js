// Tracks which configured pairs Binance currently lists for spot trading, so a delisted or halted
// pair is reported clearly and can't break requests for the others. (Binance rejects a whole
// multi-symbol ticker request if any one symbol in it is invalid.)
import { config } from './config.js';

export function createMarkets({ rest, symbols = config.symbols, refreshMs = 6 * 3600e3, retryMs = 60e3, onChange = () => {} } = {}) {
  let active = [...symbols];
  let unavailable = {};
  let verifiedAt = null;
  let lastError = null;
  let timer = null;
  let stopped = false;

  async function refresh() {
    try {
      const tradable = await rest.tradableSymbols();
      const next = symbols.filter((s) => tradable.has(s));
      const changed = next.join() !== active.join();
      active = next;
      unavailable = Object.fromEntries(symbols.filter((s) => !tradable.has(s)).map((s) => [s, 'Binance does not currently list this pair for spot trading']));
      verifiedAt = Date.now();
      lastError = null;
      if (changed) onChange(active);
      return true;
    } catch (e) {
      // Binance unreachable: keep the current list and say it is unverified, rather than dropping pairs.
      lastError = e.message;
      return false;
    }
  }

  function schedule(ok) {
    if (stopped) return;
    timer = setTimeout(async () => schedule(await refresh()), ok ? refreshMs : retryMs);
    timer.unref?.();
  }

  async function start() {
    const ok = await refresh();
    schedule(ok);
    return ok;
  }

  function stop() { stopped = true; clearTimeout(timer); }

  return {
    start,
    stop,
    refresh,
    active: () => active,
    isActive: (s) => active.includes(s),
    isConfigured: (s) => symbols.includes(s),
    reasonFor: (s) => unavailable[s] || null,
    status: () => ({ configured: symbols.length, active: active.length, verifiedAt, lastError, unavailable }),
  };
}

/** A fixed list, for callers that have no exchange check to run. */
export function staticMarkets(symbols = config.symbols) {
  return {
    active: () => symbols,
    isActive: (s) => symbols.includes(s),
    isConfigured: (s) => symbols.includes(s),
    reasonFor: () => null,
    status: () => ({ configured: symbols.length, active: symbols.length, verifiedAt: null, lastError: null, unavailable: {} }),
  };
}
