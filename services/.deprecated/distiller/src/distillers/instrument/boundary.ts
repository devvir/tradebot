import { registry, SK_PROVIDERS, logger } from '@devvir/service-kit';
import type { RedisClient }               from '@devvir/service-kit';

import { GATING_TABLES } from './types';

/** A date never gates the universe — the non-constraining boundary for an uncollected table. */
const FAR_FUTURE = '9999-12-31';

let lastBoundary: string | null = null;

/**
 * Derive the exclusive end of the settled date range the distiller may process.
 *
 * The sole authority is the Redis `farm:{table}:{date}` markers that farmer
 * writes as it imports data into MongoDB — the persistent summary of what is in
 * the database. Vault is a transient import stage whose files are removed once
 * imported; it is never consulted.
 *
 * Per gating table a marker is `done:*` (settled in MongoDB), a bare number
 * (mid-import), or absent. The table's boundary is the day after its furthest
 * `done` date; the universe boundary is the minimum across the gating tables,
 * recomputed at startup and on each idle wait. `settlement` is deliberately not
 * a gating table — see GATING_TABLES.
 *
 * The distiller processes whole hours strictly before this date.
 */
export async function computeBoundary(): Promise<string> {
  const redis   = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;
  const markers = await loadMarkers(redis);

  const boundaries = GATING_TABLES.map(table => tableBoundary(markers.get(table) ?? []));
  const boundary   = boundaries.reduce((min, b) => (b < min ? b : min));

  if (boundary !== lastBoundary) {
    logger.info({ boundary }, 'Instrument distiller: universe boundary');
    lastBoundary = boundary;
  }

  return boundary;
}

/**
 * The earliest date for which **every** gating table has a `done` marker — the
 * cold-start point. Before it, at least one required source is missing, so there
 * is nothing to distil yet. Returns `null` if no such date exists.
 */
export async function firstCompleteDate(): Promise<string | null> {
  const redis   = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;
  const markers = await loadMarkers(redis);

  const doneDates = GATING_TABLES.map(
    table => new Set((markers.get(table) ?? []).filter(m => m.done).map(m => m.date)),
  );

  if (doneDates.some(set => set.size === 0)) return null;

  let common = [...doneDates[0]!];

  for (const set of doneDates.slice(1)) common = common.filter(date => set.has(date));

  if (common.length === 0) return null;

  common.sort();

  return isoDate(common[0]!);
}

// ── Internals ─────────────────────────────────────────────────────────────────

interface Marker { date: string; done: boolean; }

/**
 * The boundary a single table imposes — the day after the furthest date it has
 * fully imported (`done`). Everything up to that date is taken as complete: an
 * absent date below it is a real gap BitMEX never published, which the distiller
 * synthesises from the other proxies rather than waiting on.
 *
 * Farmer imports out of order — it takes whatever buckets are available and
 * back-fills older dates that appear late — so the frontier is the furthest
 * `done` date, not a contiguous run. Dates still importing (`pending`) aren't
 * `done`, so they never extend the frontier. A table with no `done` markers was
 * never collected and does not gate, returning a non-constraining date.
 */
function tableBoundary(markers: Marker[]): string {
  let maxDone: string | null = null;

  for (const m of markers) {
    if (m.done && (maxDone === null || m.date > maxDone)) maxDone = m.date;
  }

  if (maxDone === null) return FAR_FUTURE;

  return addDay(isoDate(maxDone));
}

/** Read every `farm:{table}:{date}` marker from Redis, grouped by table. */
async function loadMarkers(redis: RedisClient): Promise<Map<string, Marker[]>> {
  const keys: string[] = [];

  for await (const key of redis.scanIterator({ MATCH: 'farm:*', COUNT: 500 })) {
    keys.push(key as unknown as string);
  }

  const out = new Map<string, Marker[]>();

  if (keys.length === 0) return out;

  const values = await redis.mGet(keys);

  for (let i = 0; i < keys.length; i++) {
    const parts = keys[i]!.split(':');
    const value = values[i];

    if (parts.length !== 3 || value === null) continue;

    const table = parts[1]!;
    const date  = parts[2]!;
    const done  = value.startsWith('done');

    const list = out.get(table);

    if (list) {
      list.push({ date, done });
    } else {
      out.set(table, [{ date, done }]);
    }
  }

  return out;
}

function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_tableBoundary = tableBoundary;

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
}
