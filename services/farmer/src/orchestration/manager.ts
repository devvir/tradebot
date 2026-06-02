/**
 * Owns the pending-tasks list, the ordering policy, the per-table stats
 * (in-memory) and the shared `stopSignal`. Only public surface is
 * `nextTask()`: callers ask for work and either get a Task (with the
 * shared stopSignal embedded) or `undefined` when the service is shutting
 * down. Everything else is private.
 *
 * Refresh policy:
 *   - On every refresh, a 1-minute timer arms; when it fires, the stale
 *     flag flips back to true. Lazy: while pending tasks exist, no
 *     refresh runs even if the timer fired.
 *
 * Ordering:
 *   - Within a table, dates are ascending (oldest first).
 *   - Across tables, weighted random sample: probability proportional to
 *     1 / avgProcessingTime. Tables with no stats are treated as the
 *     fastest known (optimistic). When no stats exist at all, uniform.
 */

import { logger, registry } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import type { Config } from '../types';
import { listFiles, listTables, statFile } from '../read/vault';
import { list as listProgress, type Entry } from './progress';
import { Task, type StopSignal } from './task';

const STALE_TTL_MS           = 60_000;
const EMPTY_POLL_INTERVAL_MS = 1_000;
const WEIGHT_EXPONENT        = 0.2;
/** How often each active Task checkpoints its confirmed frontier to Redis. */
const PROGRESS_INTERVAL_MS   = 1_000;

interface PendingDate {
  date: string;
  skip: number;
}

interface TableStats {
  avgTime: number;
  samples: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const nextTask = async (): Promise<Task | undefined> => {
  init();

  while (! stopSignal!.triggered) {
    if (totalPending() > 0) {
      const task = takeTask();

      /**
       * Hand the worker its task immediately, then refresh the list in the
       * background if it's gone stale. The worker never waits on a vault scan
       * while there's work to drain. `refresh()` is deduped, and `buildPending`
       * excludes anything in `inFlight` — and `takeTask` adds this bucket there
       * before the async refresh runs — so it can't reappear in the new list.
       */
      if (stale) void refresh();

      return task;
    }

    /**
     * Nothing to hand out. If the list is stale, scan now (blocking is
     * harmless — there's no work either way); otherwise wait for the periodic
     * refresh to surface new buckets.
     */
    if (stale) await refresh();
    else await sleep(EMPTY_POLL_INTERVAL_MS);
  }

  return undefined;
};

/**
 * Release a task back to the pool — called by the worker loop when
 * `readBucket` throws (e.g. vault 404). The bucket reappears in `pending`
 * on the next refresh. Successful completion goes through `trackCompletion`
 * instead, which clears the same in-flight entry.
 */
export const releaseTask = (task: Task): void => {
  inFlight.delete(keyFor(task.table, task.date));
};

// ── State ─────────────────────────────────────────────────────────────────────

let pending:    Map<BitmexTable, PendingDate[]>     = new Map();
let stale:      boolean                              = true;
let staleTimer: NodeJS.Timeout | null                = null;
let refreshing: Promise<void> | null                 = null;
const stats:    Map<BitmexTable, TableStats>         = new Map();
/** First-bucket size per table — cold-start proxy for avgTime until real stats arrive. Fetched once. */
const sizeApprox: Map<BitmexTable, number>           = new Map();
/** `table:date` keys currently held by some worker. Excluded from the rebuilt pending list on refresh. */
const inFlight: Set<string>                          = new Set();

let stopSignal: StopSignal | null                    = null;
let vaultUrl:   string | null                        = null;
let filter:     BitmexTable[]                        = [];

// ── Init (lazy, once) ─────────────────────────────────────────────────────────

const init = (): void => {
  if (stopSignal) return;

  const service = registry.get('farmer');
  const config  = service.config() as Config;

  stopSignal = { triggered: false };
  vaultUrl   = config.vaultUrl;
  filter     = config.tables;

  service.on('shutdown', () => { stopSignal!.triggered = true; });
};

// ── Refresh ───────────────────────────────────────────────────────────────────

const refresh = async (): Promise<void> => {
  if (refreshing) return refreshing;

  refreshing = doRefresh().finally(() => { refreshing = null; });

  return refreshing;
};

const doRefresh = async (): Promise<void> => {
  try {
    const [ vaultClosed, progressEntries ] = await Promise.all([
      fetchVaultClosed(),
      listProgress(),
    ]);

    pending = buildPending(vaultClosed, progressEntries);
    stale   = false;

    if (staleTimer) clearTimeout(staleTimer);

    staleTimer = setTimeout(() => { stale = true; }, STALE_TTL_MS);
    staleTimer.unref();

    await loadSizeApproximations();

    logger.info({ tables: pending.size, total: totalPending() }, 'Refreshed pending tasks');
  } catch (err) {
    logger.error({ err }, 'Refresh failed; leaving pending list unchanged');
  }
};

const fetchVaultClosed = async (): Promise<Array<{ table: BitmexTable; date: string }>> => {
  const allTables = await listTables(vaultUrl!);
  const tables    = filter.length > 0
    ? allTables.filter(t => filter.includes(t as BitmexTable))
    : allTables;

  const perTable = await Promise.all(tables.map(async (table) => {
    const files = await listFiles(vaultUrl!, table);

    if (! files) return [];

    return Object.entries(files)
      .filter(([ , state ]) => state === 'closed')
      .map(([ date ]) => ({ table: table as BitmexTable, date }));
  }));

  return perTable.flat();
};

const buildPending = (
  vaultClosed:     Array<{ table: BitmexTable; date: string }>,
  progressEntries: Entry[],
): Map<BitmexTable, PendingDate[]> => {
  const progressMap = new Map<string, Entry>();

  for (const e of progressEntries) progressMap.set(`${e.table}:${e.date}`, e);

  const out = new Map<BitmexTable, PendingDate[]>();

  for (const { table, date } of vaultClosed) {
    /** A bucket currently being worked on by a worker is "partial" in Redis
     *  but should NOT come back into the pending queue — that's what causes
     *  two workers to race on the same bucket after a refresh. */
    if (inFlight.has(keyFor(table, date))) continue;

    const prog = progressMap.get(`${table}:${date}`);

    if (prog?.state === 'done') continue;

    const skip  = prog?.messages ?? 0;
    const queue = out.get(table) ?? [];

    queue.push({ date, skip });
    out.set(table, queue);
  }

  for (const queue of out.values()) queue.sort((a, b) => a.date.localeCompare(b.date));

  return out;
};

// ── Ordering: weighted random by 1/avgTime ────────────────────────────────────

const pickTable = (tables: BitmexTable[]): BitmexTable => {
  if (tables.length === 1) return tables[0]!;

  /**
   * Per-table weight: real avgTime if measured, else the oldest-bucket file
   * size as a cold-start proxy. Falling back to the lowest known value keeps
   * truly-unknown tables (e.g. a fetch failure) from starving.
   *
   * Weight is `1 / x^0.2` to dampen the spread — a 10,000× ratio flattens
   * to ~6×, so orderBookL2 still gets regular turns while small tables
   * drain faster. Mixing time-units (ms) with size-units (bytes) is
   * imprecise but the exponent washes most of that out, and it's a
   * transient effect: as real stats accumulate they replace the proxy.
   */
  const known = [...stats.values()].map(s => s.avgTime).concat([...sizeApprox.values()]);

  if (known.length === 0) return tables[Math.floor(Math.random() * tables.length)]!;

  const fallback = Math.min(...known);

  const weights = tables.map(t => {
    const value = stats.get(t)?.avgTime ?? sizeApprox.get(t) ?? fallback;
    return 1 / (value ** WEIGHT_EXPONENT);
  });

  const total = weights.reduce((a, b) => a + b, 0);

  let r = Math.random() * total;

  for (let i = 0; i < tables.length; i++) {
    r -= weights[i]!;

    if (r <= 0) return tables[i]!;
  }

  return tables[tables.length - 1]!;
};

/**
 * Cold-start helper: once per table we fetch the file size of its oldest
 * pending bucket and cache it. Acts as a proxy for avgTime in `pickTable`
 * until that table actually completes a task and produces a real stat.
 */
const loadSizeApproximations = async (): Promise<void> => {
  const todo = Array.from(pending.entries()).filter(([t]) => ! sizeApprox.has(t));

  if (todo.length === 0) return;

  await Promise.all(todo.map(async ([table, queue]) => {
    const oldest = queue[0]!;

    try {
      const stat = await statFile(vaultUrl!, table, oldest.date);

      if (stat) sizeApprox.set(table, stat.size);
    } catch (err) {
      logger.warn({ err, table, date: oldest.date }, 'Failed to fetch size approximation');
    }
  }));

  logger.info({ count: sizeApprox.size }, 'Loaded size approximations');
};

// ── Stats ─────────────────────────────────────────────────────────────────────

const trackCompletion = (task: Task): void => {
  inFlight.delete(keyFor(task.table, task.date));

  const elapsed  = Date.now() - task.startTime;
  const existing = stats.get(task.table);

  if (! existing) {
    stats.set(task.table, { avgTime: elapsed, samples: 1 });
    return;
  }

  const samples = existing.samples + 1;
  const avgTime = existing.avgTime + (elapsed - existing.avgTime) / samples;

  stats.set(task.table, { avgTime, samples });
};

const keyFor = (table: BitmexTable, date: string): string => `${table}:${date}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull the next bucket off the list (ordering picks the table, oldest date
 *  first), mark it in-flight, and wrap it in a Task. Caller has checked the
 *  list is non-empty. */
const takeTask = (): Task => {
  const tables         = Array.from(pending.keys());
  const table          = pickTable(tables);
  const queue          = pending.get(table)!;
  const { date, skip } = queue.shift()!;

  if (queue.length === 0) pending.delete(table);

  inFlight.add(keyFor(table, date));

  return new Task({
    table, date, skip,
    intervalMs: PROGRESS_INTERVAL_MS,
    stopSignal: stopSignal!,
    onComplete: trackCompletion,
  });
};

const totalPending = (): number => {
  let n = 0;

  for (const arr of pending.values()) n += arr.length;

  return n;
};

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms));

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_STALE_TTL_MS           = STALE_TTL_MS;
export const _test_EMPTY_POLL_INTERVAL_MS = EMPTY_POLL_INTERVAL_MS;
export const _test_WEIGHT_EXPONENT        = WEIGHT_EXPONENT;
export const _test_buildPending           = buildPending;
export const _test_pickTable              = pickTable;
export const _test_trackCompletion        = trackCompletion;
export const _test_seedInFlight           = (table: BitmexTable, date: string): void => {
  inFlight.add(keyFor(table, date));
};
/** Seed a fresh (non-stale) pending list and a live stopSignal so `nextTask`
 *  hands out from it directly — `init()` short-circuits on the set stopSignal,
 *  so no registry/vault is touched. */
export const _test_primeForHandout        = (buckets: Array<{ table: BitmexTable; date: string; skip?: number }>): void => {
  stopSignal = { triggered: false };
  stale      = false;
  pending    = new Map();

  for (const { table, date, skip } of buckets) {
    const queue = pending.get(table) ?? [];

    queue.push({ date, skip: skip ?? 0 });
    pending.set(table, queue);
  }
};
export const _test_resetManager           = (): void => {
  pending    = new Map();
  stale      = true;
  refreshing = null;
  stats.clear();
  sizeApprox.clear();
  inFlight.clear();
  stopSignal = null;
  vaultUrl   = null;
  filter     = [];

  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
};
