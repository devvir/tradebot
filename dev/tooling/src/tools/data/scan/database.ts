import { createClient } from 'redis';
import { getEnv } from '../../../shared/utils/env';
import { ALL_TABLE_NAMES } from './tables';

/**
 * Per-(table, day) mongo import status, scanned from farmer's
 * `farm:<table>:<date>` Redis keys. Farmer (services/farmer) is the only
 * writer; this scanner is read-only.
 *
 * Value semantics (matches `services/farmer/src/orchestration/progress.ts`):
 *   - `done:<count>` → entry.status = 'done'    (fully imported)
 *   - numeric        → entry.status = 'partial' (mid-import, counter = highest msgIndex)
 *   - missing key    → no entry returned for this (table, day)
 */

export interface DatabaseEntry {
  table:  string;
  day:    string;
  status: 'done' | 'partial';
}

const KEY_PREFIX = 'farm:';

/**
 * Verifies the local Redis is reachable. Mirrors `checkMegaAvailable`'s
 * fail-fast pattern — `data status` requires Redis to populate the
 * Database column, so dying with a clear message is better than silently
 * showing every day as "missing".
 */
export async function checkDatabaseAvailable(): Promise<void> {
  const client = createClient({ url: buildRedisUrl() });

  client.on('error', () => { /* swallow; ping() below surfaces the failure */ });

  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    throw new Error(
      `Redis is not reachable at ${redactedUrl()}. ` +
      `Set CACHE_PASS / CACHE_PORT in dev/tooling/.env and ensure Redis is running. ` +
      `(${msg})`,
    );
  } finally {
    await client.quit().catch(() => { /* already disconnected */ });
  }
}

/**
 * Scans every `farm:<table>:<date>` key and returns one entry per known
 * (table, day) with a recognised value. Unknown tables and malformed keys
 * are silently skipped — farmer is the schema owner.
 */
export async function scanDatabase(): Promise<DatabaseEntry[]> {
  const client = createClient({ url: buildRedisUrl() });

  client.on('error', () => { /* connection errors surface via connect() reject */ });

  await client.connect();

  try {
    const keys: string[] = [];

    for await (const k of client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 500 })) {
      keys.push(k);
    }

    if (keys.length === 0) return [];

    const values = await client.mGet(keys);
    const out:    DatabaseEntry[] = [];

    for (let i = 0; i < keys.length; i++) {
      const parsed = parseKey(keys[i]!);

      if (! parsed)                        continue;
      if (! ALL_TABLE_NAMES.has(parsed.table)) continue;

      const status = decode(values[i]);

      if (! status) continue;

      out.push({ table: parsed.table, day: parsed.day, status });
    }

    return out;
  } finally {
    await client.quit();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseKey(raw: string): { table: string; day: string } | null {
  const parts = raw.split(':');

  if (parts.length !== 3)         return null;
  if (parts[0] !== 'farm')        return null;
  if (! /^\d{8}$/.test(parts[2]!)) return null;

  return { table: parts[1]!, day: parts[2]! };
}

function decode(raw: string | null): 'done' | 'partial' | null {
  if (raw === null)            return null;
  if (raw.startsWith('done'))  return 'done';
  if (/^\d+$/.test(raw))       return 'partial';

  return null;
}

function buildRedisUrl(): string {
  const pass = getEnv('CACHE_PASS') ?? '';
  const port = getEnv('CACHE_PORT') ?? '6379';

  return `redis://:${pass}@localhost:${port}`;
}

function redactedUrl(): string {
  const port = getEnv('CACHE_PORT') ?? '6379';

  return `redis://localhost:${port}`;
}
