import { useEffect, useState } from 'react';

/**
 * Reaching the services, and waiting for them.
 *
 * **Everything goes to this page's own origin**, never to the catalog directly:
 * the server behind it adds the token and forwards. So there is no base URL to
 * configure here, no CORS to arrange, and no secret in the bundle.
 */

export const catalog = <T>(path: string): Promise<T> => ask<T>(`/api/catalog${path}`);

/**
 * A catalog path as seen through a lens, as one key: changing the lens changes
 * the key, so `useAsk` asks again rather than showing the last lens's answer.
 */
export const lensed = (path: string, lens: string | null | undefined): string =>
  (lens ? `${path}${LENS_MARK}${lens}` : path);

/** Ask for a `lensed` key, sending its lens as `x-catalog-lens`. */
export const catalogLensed = <T>(key: string): Promise<T> => {
  const [path, lens] = key.split(LENS_MARK);

  return ask<T>(`/api/catalog${path}`, lens ? { headers: { 'x-catalog-lens': lens } } : undefined);
};

/** Anything that changes something. The body is JSON or nothing. */
export const post = <T>(url: string, body?: unknown): Promise<T> =>
  ask<T>(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body ?? {}),
  });

/** A change to something that already exists. */
export const patch = <T>(url: string, body: unknown): Promise<T> =>
  ask<T>(url, {
    method:  'PATCH',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });

/** A replacement of something whole, which is how a lens is written. */
export const put = <T>(url: string, body: unknown): Promise<T> =>
  ask<T>(url, {
    method:  'PUT',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });

/** Taking something away. Answers whatever the service says it removed. */
export const remove = <T>(url: string): Promise<T> => ask<T>(url, { method: 'DELETE' });

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

/** What separates a path from its lens inside one key; never part of a real path. */
const LENS_MARK = '\u0000lens=';

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
