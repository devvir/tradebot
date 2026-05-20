import { registry, SK_PROVIDERS, logger } from '@devvir/service-kit';
import type { RedisClient }               from '@devvir/service-kit';

import { UNIVERSE_START, GATING_TABLES } from './types';

const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES    = 4;

/**
 * Derive the exclusive end of the settled date range the distiller may process.
 *
 * The boundary is the earliest date any gating table has a vault bucket that is
 * not yet `done:*` in Redis — the minimum across per-table boundaries. Re-run at
 * startup and on every idle wait, in case farmer has imported more meanwhile.
 *
 * The distiller processes whole hours strictly before this date.
 */
export async function computeBoundary(vaultUrl: string): Promise<string> {
  const redis = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;

  const boundaries = await Promise.all(
    GATING_TABLES.map(table => tableBoundary(vaultUrl, redis, table)),
  );

  const boundary = boundaries.reduce((min, b) => (b < min ? b : min));

  logger.info({ start: UNIVERSE_START, boundary }, 'instrument: universe boundary');

  return boundary;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The earliest date `table` has a vault bucket not yet `done:*` in Redis. When
 * every bucket is imported, the boundary is the day after the last. A date with
 * no vault file is never collected — it is skipped, not treated as a boundary.
 */
async function tableBoundary(vaultUrl: string, redis: RedisClient, table: string): Promise<string> {
  const dates = await vaultDates(vaultUrl, table);

  if (dates.length === 0) return UNIVERSE_START;

  const keys   = dates.map(d => `farm:${table}:${d}`);
  const values = await redis.mGet(keys);

  for (let i = 0; i < dates.length; i++) {
    const value = values[i];

    if (value === null || ! value.startsWith('done')) return isoDate(dates[i]!);
  }

  return addDay(isoDate(dates[dates.length - 1]!));
}

/** Sorted `YYYYMMDD` dates that have a bucket file for `table` in vault. */
async function vaultDates(vaultUrl: string, table: string): Promise<string[]> {
  const files = await fetchVaultFiles(`${vaultUrl}/files/${table}`);

  if (! files) return [];

  return Object.keys(files).sort();
}

async function fetchVaultFiles(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 404) return null;

      if (! res.ok) throw new Error(`vault HTTP ${res.status}`);

      return await res.json() as Record<string, unknown>;
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;

      logger.warn({ url, err }, 'instrument: vault unreachable — retrying');
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);

  d.setUTCDate(d.getUTCDate() + 1);

  return d.toISOString().slice(0, 10);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
