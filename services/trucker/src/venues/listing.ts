import { dashed } from '../dates';
import type { ArchiveFile } from '../types';
import type { S3Page, TtlCache } from './types';

/**
 * Shared discovery helpers. Three venues (Binance, KuCoin, HTX) publish an S3
 * bucket listing; one (Bybit) an HTML index. Both are read-only enumerations of
 * what exists, so neither can return a file that 404s.
 */

/**
 * List an S3 bucket prefix. `delimiter` collapses one level, giving the child
 * "directories" in `prefixes`; without it, every key beneath the prefix is
 * returned. Paginates on `NextMarker`/last key until exhausted.
 */
export const s3List = async (
  base:      string,
  prefix:    string,
  delimiter: boolean,
  from?:     string,
): Promise<{ prefixes: string[]; keys: string[] }> => {
  const prefixes: string[] = [];
  const keys:     string[] = [];

  /**
   * `from` starts the listing partway in rather than at the beginning of the
   * prefix. S3 returns keys in lexicographic order and these venues date their
   * filenames in ISO form, so lexicographic order *is* chronological order and
   * a caller that already holds everything up to a date can skip straight to it.
   *
   * Without it, discovering that a settled symbol has nothing new costs a walk
   * over its entire history — around 3,300 keys and four pages for a Binance
   * symbol listed in 2017, at roughly 2.8 s per request.
   */
  let marker: string | null = from ?? null;

  do {
    // Prefix and marker go in **unencoded**: KuCoin's endpoint serves its HTML
    // page instead of the XML listing when the slashes are percent-encoded, and
    // S3 accepts the raw form everywhere. Keys here are only alphanumerics,
    // `/`, `-`, `_` and `.`, so nothing needs escaping.
    // `max-keys` is always sent, and not only to size the page: KuCoin's
    // endpoint serves its HTML index when `prefix` is the *only* query
    // parameter, and the XML listing when anything else is present.
    const url  = `${base}?prefix=${prefix}&max-keys=1000`
               + (delimiter ? '&delimiter=/' : '')
               + (marker ? `&marker=${marker}` : '');
    const page = parseS3Page(await fetchText(url));

    prefixes.push(...page.prefixes);
    keys.push(...page.keys);

    marker = page.next;
  } while (marker);

  return { prefixes, keys };
};

/** Extract `href` targets from an HTML directory index, minus the parent link. */
export const htmlList = async (url: string): Promise<string[]> => {
  const html = await fetchText(url);

  return [...html.matchAll(/href="([^"]+)"/g)]
    .map(m => m[1]!)
    .filter(h => h !== '../' && ! h.startsWith('?') && ! h.startsWith('/'));
};

/**
 * List a symbol whose files sit one level down, under an interval directory,
 * starting each interval at the cursor.
 *
 * This is the listing that could not be bounded. A marker built from the symbol
 * sorts *below* every interval directory — `1m/` begins with a digit, `BTCUSDT-…`
 * with a letter — so marking the symbol prefix skips the entire history rather
 * than the part already held. The alternative was to list the symbol unmarked,
 * which on a binance kline symbol is ~87 pages of keys to find the handful
 * added since yesterday.
 *
 * One `delimiter=/` request answers which intervals exist, and each is then
 * marked in its own right. A refresh drops from ~87 pages to one request plus a
 * single page per interval — and the intervals are read from the venue rather
 * than declared, so a new one appears without a code change.
 *
 * `stem` builds the filename prefix an interval's keys carry, which differs per
 * venue — `BTCUSDT-1h-` on binance and kucoin, `BTC-USDT-klines-1h-` on HTX.
 * Returning null asks for the interval unmarked, which is what a series whose
 * filename shape has not been read off a live listing gets: still one directory
 * rather than the whole symbol, without inventing a name.
 */
export const listNested = async (
  base:   string,
  prefix: string,
  stem:   (interval: string) => string | null,
  since:  string | null | undefined,
): Promise<string[]> => {
  const { prefixes } = await s3List(base, prefix, true);
  const keys: string[] = [];

  for (const dir of prefixes) {
    const interval = dir.slice(prefix.length).replace(/\/$/, '');

    // The delimiter reply echoes the request prefix alongside the children.
    if (! interval) continue;

    // A stem that is not verified for this series returns null: the interval is
    // then listed whole rather than marked, because a marker built from a
    // guessed filename skips everything instead of failing.
    const name = stem(interval);
    const from = since && name ? `${dir}${name}${dashed(since)}` : undefined;

    keys.push(...(await s3List(base, dir, false, from)).keys);
  }

  return keys;
};

/**
 * POST a JSON body and read a JSON reply, retrying transient failures exactly
 * as a listing does.
 *
 * The portal index endpoints are the one discovery path with a rate limit that
 * bites — bitget answers 429 and OKX `50011` under a burst — and losing a
 * symbol for a whole sweep to a limit that clears in a second is the kind of
 * fault that only shows up as a month that never closes.
 */
export const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body:    JSON.stringify(body),
      });

      if (res.ok) return await res.json() as T;

      // A refusal that is not congestion is an answer; repeating it just delays
      // the inevitable.
      if (res.status < 500 && res.status !== 429)
        throw new Error(`Index failed ${res.status}: ${url}`);

      last = new Error(`Index failed ${res.status}: ${url}`);
    } catch (err) {
      if (err instanceof Error && /^Index failed [45]/.test(err.message)
          && ! /Index failed (5\d\d|429)/.test(err.message)) throw err;

      last = err;
    }

    if (attempt < ATTEMPTS) await sleep(delayFor(attempt));
  }

  throw last instanceof Error ? last : new Error(`Index failed: ${url}`);
};

/** Files whose period is strictly after `since`, in period order. */
export const after = (files: ArchiveFile[], since: string | null): ArchiveFile[] => {
  const kept = since ? files.filter(f => f.date > since) : files;

  return kept.sort((a, b) => a.date.localeCompare(b.date));
};

/**
 * Expiring in-process cache for venue instrument metadata. The expiry is what
 * lets the periodic rescan see newly listed symbols: a cache that lives for the
 * process would freeze every constructed-URL venue's universe at startup.
 */
export const ttlCache = <T>(ttlMs: number): TtlCache<T> => {
  const store = new Map<string, { at: number; value: T }>();

  return {
    get: (key) => {
      const entry = store.get(key);

      if (! entry || Date.now() - entry.at >= ttlMs) return null;

      return entry.value;
    },
    set:   (key, value) => { store.set(key, { at: Date.now(), value }); },
    clear: () => store.clear(),
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

const parseS3Page = (xml: string): S3Page => {
  const tag = (name: string): string[] =>
    [...xml.matchAll(new RegExp(`<${name}>([^<]+)</${name}>`, 'g'))].map(m => m[1]!);

  const keys       = tag('Key');
  const truncated  = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextMarker = tag('NextMarker')[0] ?? null;

  // Child directories come as `<CommonPrefixes><Prefix>`. The response also
  // carries a bare top-level `<Prefix>` echoing the request, which ends in `/`
  // like the rest — matching `<Prefix>` alone turns it into a phantom symbol
  // named after the last path segment (`trades`, `klines`) on every S3 venue.
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)]
    .map(m => m[1]!);

  // S3 omits NextMarker when a delimiter is absent; the last key is the marker.
  const next = truncated ? (nextMarker ?? keys[keys.length - 1] ?? null) : null;

  return { prefixes, keys, next };
};

/** Attempts a listing gets before the symbol is given up on for this sweep. */
const ATTEMPTS = 5;
const BASE_MS  = 500;
const MAX_MS   = 30_000;

/**
 * Fetch a listing, retrying transient failures.
 *
 * Listings were previously the one network call with no retry at all, while
 * downloads got five attempts — so a single dropped socket cost the whole
 * symbol for the entire sweep. S3 reaps idle keep-alive connections, and
 * undici will happily reuse one it has already closed, which surfaces as
 * `fetch failed: other side closed` every few minutes on whichever venue lists
 * slowly enough for its pooled sockets to go idle. That is ordinary internet,
 * not a fault worth losing a symbol over.
 *
 * Only transport errors and 5xx/429 are retried. A 403 or 404 on a listing is
 * an answer, not a hiccup, and repeating it just delays the inevitable.
 */
const fetchText = async (url: string): Promise<string> => {
  let last: unknown;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);

      if (res.ok) return await res.text();

      if (res.status < 500 && res.status !== 429)
        throw new Error(`Listing failed ${res.status}: ${url}`);

      last = new Error(`Listing failed ${res.status}: ${url}`);
    } catch (err) {
      // A non-2xx we decided not to retry is final; rethrow it untouched.
      if (err instanceof Error && /^Listing failed [45]/.test(err.message)
          && ! /Listing failed (5\d\d|429)/.test(err.message)) throw err;

      last = err;
    }

    if (attempt < ATTEMPTS) await sleep(delayFor(attempt));
  }

  throw last instanceof Error ? last : new Error(`Listing failed: ${url}`);
};

/** Exponential with full jitter, so retries across venues do not synchronise. */
const delayFor = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS));

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
