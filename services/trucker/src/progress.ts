import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import config from './config';
import type { SymbolCache } from './types';

/**
 * Which symbols a venue publishes, remembered between runs.
 *
 * Listing them costs a bucket enumeration or an instruments API call per
 * dataset, and the answer changes on the timescale of listings rather than of
 * runs — so it is asked for once every `SYMBOL_TTL_SECS` and kept in memory in
 * between.
 *
 * Two guards on top of the cache:
 *
 * - An **empty list is never recorded**. Empty means the load faulted (every
 *   collected dataset has symbols), and keeping it would collect nothing for
 *   the whole TTL with no error anywhere.
 * - What is returned is the **union of the live list and every symbol ever
 *   seen**. Venues that enumerate from their live instruments API stop
 *   mentioning a symbol the day it delists, while its history stays on the CDN;
 *   without the union those archives would become unreachable.
 *
 * Stored beside the other ledgers, in the same dull shape — tab-separated,
 * append-only, one file per venue — with a tag column because two kinds of
 * record share the file:
 *
 *     spot-deals\tsymbol\tBTC_USDT
 *     spot-deals\tfetched\t2026-08-01T09:15:04.112Z
 *
 * A symbol is appended only the first time it is seen, so the file grows with
 * the venue's catalogue rather than with passes. A tag column rather than two
 * files because venue symbols contain nearly every punctuation character and
 * none of them can collide with a fixed tag in a column of its own.
 */

const DIR = () => join(config.dataDir, '@meta', 'symbols');

const fileFor = (venue: string): string => join(DIR(), `${venue}.tsv`);

/** One in-memory copy per venue; trucker is the only writer. */
const memo = new Map<string, Promise<SymbolCache>>();

export const cachedSymbols = async (
  venue:   string,
  dataset: string,
  ttlSecs: number,
  load:    () => Promise<string[]>,
): Promise<string[]> => {
  const state = await cached(venue);
  const ever  = state.ever.get(dataset) ?? new Set<string>();

  if (ever.size > 0 && fresh(state.fetched.get(dataset), ttlSecs)) return sorted(ever);

  const live = await load();

  // A faulted listing leaves the stamp alone, so the next sweep asks again
  // rather than trusting a gap for the length of the TTL.
  if (live.length === 0) return [];

  const stamp = new Date().toISOString();
  const added = live.filter(symbol => ! ever.has(symbol));
  const lines = [
    ...added.map(symbol => `${dataset}\tsymbol\t${symbol}\n`),
    `${dataset}\tfetched\t${stamp}\n`,
  ];

  const path = fileFor(venue);

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.join(''));

  for (const symbol of added) ever.add(symbol);

  state.ever.set(dataset, ever);
  state.fetched.set(dataset, stamp);

  return sorted(ever);
};

/** Every symbol ever seen, per dataset — the venue's whole known universe. */
export const known = async (venue: string): Promise<Map<string, Set<string>>> =>
  (await cached(venue)).ever;

// ── Internals ─────────────────────────────────────────────────────────────────

/** The venue's file, read once and held; the promise so concurrent starts share it. */
const cached = (venue: string): Promise<SymbolCache> => {
  const held = memo.get(venue);

  if (held) return held;

  const loading = read(venue);

  memo.set(venue, loading);

  return loading;
};

const read = async (venue: string): Promise<SymbolCache> => {
  const state: SymbolCache = { ever: new Map(), fetched: new Map() };
  const raw = await readFile(fileFor(venue), 'utf8').catch(() => '');

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    // A torn last line — the write was interrupted — is ignored rather than
    // failing the read, exactly as the other ledgers treat one.
    if (parts.length !== 3) continue;

    const [dataset, tag, value] = parts as [string, string, string];

    if (tag === 'symbol') {
      const ever = state.ever.get(dataset) ?? new Set<string>();

      ever.add(value.trim());
      state.ever.set(dataset, ever);
    }

    if (tag === 'fetched') state.fetched.set(dataset, value.trim());
  }

  return state;
};

/** Whether the venue was asked recently enough to take its answer as current. */
const fresh = (stamp: string | undefined, ttlSecs: number): boolean => {
  if (! stamp) return false;

  const at = Date.parse(stamp);

  return Number.isFinite(at) && Date.now() - at < ttlSecs * 1000;
};

const sorted = (symbols: Set<string>): string[] => [...symbols].sort();
