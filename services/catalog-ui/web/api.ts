import { useEffect, useState } from 'react';

/**
 * Reaching the services, and waiting for them.
 *
 * **Everything goes to this page's own origin**, never to the catalog directly:
 * the server behind it adds the token and forwards. So there is no base URL to
 * configure here, no CORS to arrange, and no secret in the bundle.
 */

export const catalog = <T>(path: string): Promise<T> => ask<T>(`/api/catalog${path}`);
export const hauler  = <T>(path: string): Promise<T> => ask<T>(`/api/hauler${path}`);

/** Anything that changes something. The body is JSON or nothing. */
export const post = <T>(url: string, body?: unknown): Promise<T> =>
  ask<T>(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body ?? {}),
  });

/** What a view holds while it waits, and what it shows if the answer never comes. */
export interface Asked<T> {
  data?:  T;
  error?: string;
  loading: boolean;
}

/**
 * Ask once per distinct path, and forget an answer that arrived too late.
 *
 * **The stale-answer guard is the whole reason this is a hook.** Clicking
 * through three venues quickly fires three requests, and without it whichever
 * lands last wins — which is not necessarily the one being looked at.
 */
export const useAsk = <T>(path: string | null, ask: (path: string) => Promise<T>): Asked<T> => {
  const [state, setState] = useState<Asked<T>>({ loading: path !== null });

  useEffect(() => {
    if (path === null) return;

    let current = true;

    setState({ loading: true });

    ask(path)
      .then(data => { if (current) setState({ data, loading: false }); })
      .catch((err: Error) => { if (current) setState({ error: err.message, loading: false }); });

    return () => { current = false; };
  }, [path]);

  return state;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * **The body of a failure is kept, not summarised.** These services answer a
 * refusal with a sentence saying what was wrong with the request — which is the
 * useful half, and exactly what a generic "request failed" throws away.
 */
const ask = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const res  = await fetch(url, init);
  const text = await res.text();

  if (! res.ok) throw new Error(`${res.status} — ${detail(text)}`);

  return JSON.parse(text) as T;
};

const detail = (text: string): string => {
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text.slice(0, 300);
  }
};
