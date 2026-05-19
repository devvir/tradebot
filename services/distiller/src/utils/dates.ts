import { logger, registry, SK_PROVIDERS } from '@devvir/service-kit';
import type { RedisClient } from '@devvir/service-kit';

const REFRESH_MS             = 30 * 1_000;
const SOURCE_PROGRESS_PREFIX = 'farm';

// ── Module-level state ────────────────────────────────────────────────────────

/** Per-source cache of source-done dates (importer-confirmed in MongoDB). */
const sourceCache = new Map<string, { dates: Set<string>; at: number }>();

/** Per-target cache of distiller-done dates. */
const distCache   = new Map<string, { dates: Set<string>; at: number }>();

// ── Public API ────────────────────────────────────────────────────────────────

export interface DateWalker {
  /** Blocks until the next pending date is available, then returns it.
   *  Calling next() marks the *previously returned* date as done before returning the new one.
   *  If you stop calling next() or throw, the last-returned date is not marked — it will be
   *  re-yielded on the next run (idempotent). */
  next(): Promise<string>;
}

export function dateWalker(
  target: string,
  source: string | string[],
): DateWalker {
  const redis   = registry.get('distiller', SK_PROVIDERS).get('redis') as RedisClient;
  const sources = Array.isArray(source) ? source : [source];
  let   prev: string | null = null;

  return { next };

  async function next(): Promise<string> {
    while (true) {
      try {
        if (prev !== null) {
          await redis.set(`distiller_${target}_${isoToYYYYMMDD(prev)}`, 'done');
          distCache.get(target)?.dates.add(prev);
          prev = null;
        }

        const now = Date.now();

        await maybeRefreshSources(redis, sources, now);
        await maybeRefreshDist(redis, target, now);

        const candidate = findCandidate(sources, target);

        if (candidate === null) {
          logger.debug({ target, sources }, '[dateWalker] no date ready — waiting');
        }

        if (candidate !== null) {
          // Cheap guard: confirm this date isn't already done in Redis before yielding.
          // Protects against a stale distCache (e.g. after a restart with a cold scan).
          const alreadyDone = await redis.get(`distiller_${target}_${isoToYYYYMMDD(candidate)}`);

          if (alreadyDone === 'done') {
            const entry = distCache.get(target);
            if (entry) entry.at = 0;
            continue;
          }

          prev = candidate;
          return candidate;
        }
      } catch (err) {
        logger.error({ err }, '[dateWalker] Redis error — retrying');
      }

      await sleep(REFRESH_MS);
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function findCandidate(sources: string[], target: string): string | null {
  const distDone   = distCache.get(target)?.dates ?? new Set<string>();
  const firstDates = sourceCache.get(sources[0]!)?.dates ?? new Set<string>();
  const candidates: string[] = [];

  for (const date of firstDates) {
    if (distDone.has(date)) continue;

    // Must be done in every source — `done:<count>` means the importer has
    // confirmed every message of that bucket is in MongoDB.
    if (! sources.every(s => sourceCache.get(s)?.dates.has(date))) continue;

    candidates.push(date);
  }

  if (candidates.length === 0) return null;

  candidates.sort();

  return candidates[0]!;
}

async function maybeRefreshSources(redis: RedisClient, sources: string[], now: number): Promise<void> {
  for (const src of sources) {
    const entry = sourceCache.get(src);

    if (entry && now - entry.at < REFRESH_MS) continue;

    const prefix = `${SOURCE_PROGRESS_PREFIX}:${src}:`;
    const raw    = await scanDone(redis, `${prefix}*`, prefix);
    const dates  = new Set(Array.from(raw).map(yyyymmddToIso));

    sourceCache.set(src, { dates, at: now });
  }
}

async function maybeRefreshDist(redis: RedisClient, target: string, now: number): Promise<void> {
  const entry = distCache.get(target);

  if (entry && now - entry.at < REFRESH_MS) return;

  const raw   = await scanDone(redis, `distiller_${target}_*`, `distiller_${target}_`);
  const dates = new Set(Array.from(raw).map(yyyymmddToIso));

  distCache.set(target, { dates, at: now });
}

async function scanDone(redis: RedisClient, pattern: string, strip: string): Promise<Set<string>> {
  const keys: string[] = [];

  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    keys.push(key);
  }

  if (keys.length === 0) return new Set();

  const values = await redis.mGet(keys);
  const dates  = new Set<string>();

  for (let i = 0; i < keys.length; i++) {
    const v = values[i];

    if (v !== null && v.startsWith('done')) dates.add(keys[i]!.slice(strip.length));
  }

  return dates;
}

/** Source and distiller keys use YYYYMMDD; internal dates are YYYY-MM-DD. */
function yyyymmddToIso(d: string): string {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function isoToYYYYMMDD(d: string): string {
  return d.slice(0, 4) + d.slice(5, 7) + d.slice(8, 10);
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_findCandidate = findCandidate;
export const _test_sourceCache   = sourceCache;
export const _test_distCache     = distCache;
export const _test_reset         = (): void => {
  sourceCache.clear();
  distCache.clear();
};
