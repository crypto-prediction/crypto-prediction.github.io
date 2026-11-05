// Small shared pieces for the lab tabs, built from the dashboard's existing styles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib.js';

/** Fetches a URL, optionally refreshing while the tab is open. Keeps the last good data on a failed refresh. */
export function useApi(url, { every = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const id = ++latest.current;
    try {
      const data = await api(url);
      if (id === latest.current) setState({ data, error: '', loading: false });
    } catch (e) {
      if (id === latest.current) setState((s) => ({ ...s, error: e.message, loading: false }));
    }
  }, [url]);
  useEffect(() => {
    setState({ data: null, error: '', loading: true });
    load();
    if (!every) return undefined;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every]);
  return { ...state, reload: load };
}

export function Status({ loading, error, data, what = 'data' }) {
  if (error) return <p role="alert" className="text-sm text-rose-neon">{data ? `Refresh failed, showing the last result: ${error}` : `Could not load ${what}: ${error}`}</p>;
  if (loading && !data) return <p role="status" className="text-sm text-mute">Loading {what}…</p>;
  return null;
}

export function Stat({ label, value, note, className = '' }) {
  return (
    <div className="bg-ink-900 px-3 py-2">
      <div className="label">{label}</div>
      <div className={`num text-base ${className}`}>{value}</div>
      {note && <div className="text-[11px] text-mute">{note}</div>}
    </div>
  );
}

export function StatGrid({ children, className = 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6' }) {
  return <div className={`grid gap-px overflow-hidden rounded border border-ink-700 bg-ink-700 ${className}`}>{children}</div>;
}

/** States plainly whether AI is available, and what happened on the last real call. */
export function AiBadge({ ai }) {
  if (!ai) return null;
  const text = {
    'not-configured': 'AI off: no API key is set',
    untested: `AI configured (${ai.model}), not called yet`,
    ok: `AI working (${ai.model})`,
    error: `AI unavailable: ${ai.detail}`,
  }[ai.state];
  const color = ai.state === 'ok' ? 'border-lime-neon/50 text-lime-neon' : ai.state === 'error' ? 'border-amber-neon/50 text-amber-neon' : 'border-ink-600 text-mute';
  return <span data-ai-status={ai.state} className={`inline-block rounded border px-2 py-0.5 text-[11px] ${color}`}>{text}</span>;
}

export const Empty = ({ children }) => <p className="text-sm text-mute">{children}</p>;
