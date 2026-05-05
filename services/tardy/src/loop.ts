import { logger } from '@devvir/service-kit';
import config from './config';
import type { Buf, TardyTable } from './types';
import { streamMinute, MINUTES_PER_DAY } from './tardis';
import type { TardisMessage } from './tardis';
import { listFiles, writeRows, closeFile, deleteFile } from './vault';

const TABLES: TardyTable[] = [
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
];

const BATCH_SIZE  = 100_000;
const CONCURRENCY = 3;

// ── Entry point ───────────────────────────────────────────────────────────────

export const runLoop = async (vaultUrl: string): Promise<void> => {
  await syncAll(vaultUrl);

  scheduleNextPoll(vaultUrl);
};

// ── Sync ──────────────────────────────────────────────────────────────────────

export const syncAll = async (vaultUrl: string): Promise<void> => {
  const dates = targetDates(config.startDate);

  logger.info({ count: dates.length }, 'Checking target dates');

  for (const date of dates)
    await syncDate(vaultUrl, date);

  logger.info('Sync complete');
};

/**
 * For a single date, determines which tables still need data, streams from
 * Tardis, and writes to vault. Skips the date entirely if all tables are
 * already closed.
 */
export const syncDate = async (vaultUrl: string, date: string): Promise<void> => {
  const needed = await resolveTables(vaultUrl, date, config.suffix);

  if (needed.length === 0) return;

  logger.info({ date, tables: needed }, 'Fetching from Tardis');

  const batches = new Map<TardyTable, Buf>(
    needed.map(t => [t, { rows: [] }]),
  );

  // Fetch up to CONCURRENCY minutes ahead in parallel, then process and write
  // in offset order. Vault backpressure is natural: writeRows awaits vault,
  // so the loop only advances when vault has accepted the current batch.
  const inFlight: Promise<TardisMessage[]>[] = [];
  let nextToLaunch = 0;

  while (nextToLaunch < Math.min(CONCURRENCY, MINUTES_PER_DAY)) {
    inFlight.push(collectMinute(date, nextToLaunch++, needed));
  }

  for (let offset = 0; offset < MINUTES_PER_DAY; offset++) {
    if (nextToLaunch < MINUTES_PER_DAY) {
      inFlight.push(collectMinute(date, nextToLaunch++, needed));
    }

    const messages = await inFlight.shift()!;

    for (const { table, msg } of messages) {
      const buf = batches.get(table)!;

      buf.rows.push(msg);

      if (buf.rows.length >= BATCH_SIZE)
        await writeRows(vaultUrl, table, date, buf.rows.splice(0), config.suffix);
    }

    // End-of-minute flush: drain sparse tables that won't hit the batch threshold.
    for (const [table, buf] of batches.entries())
      if (buf.rows.length > 0)
        await writeRows(vaultUrl, table, date, buf.rows.splice(0), config.suffix);
  }

  for (const table of needed) {
    await closeFile(vaultUrl, table, date, config.suffix);

    logger.info({ table, date }, 'Closed');
  }
};

// ── Minute collection ────────────────────────────────────────────────────────

const RETRY_BASE_MS = 1_000;
const MAX_RETRY_MS  = 5 * 60 * 1_000; // 5 minutes

/**
 * Collects all messages from a single Tardis minute-bucket into an array.
 * Called concurrently for multiple offsets; results are consumed in order.
 * Retries the full stream on network errors.
 */
const collectMinute = async (
  date:   string,
  offset: number,
  tables: TardyTable[],
): Promise<TardisMessage[]> => {
  let attempt = 0;

  for (;;) {
    try {
      const messages: TardisMessage[] = [];

      for await (const msg of streamMinute(date, offset, tables)) {
        messages.push(msg);
      }

      return messages;
    } catch (err) {
      const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), MAX_RETRY_MS);

      logger.warn({ date, offset, attempt, delay, err }, 'Stream error — retrying');
      await sleep(delay);
      attempt++;
    }
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// ── Table resolution ──────────────────────────────────────────────────────────

/**
 * Queries vault for each table and returns only those that need downloading.
 * Deletes any open files first (crash recovery) and excludes closed ones.
 */
const resolveTables = async (vaultUrl: string, date: string, suffix: string): Promise<TardyTable[]> => {
  const needed:  TardyTable[] = [];
  const fileKey = suffix ? `${date}.${suffix}` : date;

  for (const table of TABLES) {
    const files = await listFiles(vaultUrl, table, suffix);
    const state = files[fileKey];

    if (state === 'closed') continue;

    if (state === 'open') {
      logger.info({ table, date }, 'Deleting open file (recovery)');
      await deleteFile(vaultUrl, table, date, suffix);
    }

    needed.push(table);
  }

  return needed;
};

// ── Midnight scheduling ───────────────────────────────────────────────────────
//
// Self-rescheduling timer that fires at UTC midnight. A new first-of-month
// date becomes eligible roughly once a month, so daily checks are sufficient.

const scheduleNextPoll = (vaultUrl: string): void => {
  setTimeout(async () => {
    logger.info('Midnight UTC — checking for new first-of-month dates');

    await syncAll(vaultUrl).catch(err => logger.error({ err }, 'Sync error'));

    scheduleNextPoll(vaultUrl);
  }, msToNextMidnightUTC());
};

// ── Date utilities ────────────────────────────────────────────────────────────

/**
 * Returns all first-of-month dates (YYYYMMDD) from startDate up to the last
 * eligible date. A date is eligible when date + 2 days <= now UTC, ensuring
 * the full day's data is available on Tardis before we attempt to fetch it.
 *
 * If startDate is not itself the 1st of a month, iteration starts from the
 * 1st of the following month — the current month's 1st has already passed.
 */
export const targetDates = (startDate: string): string[] => {
  const dates: string[] = [];
  const cutoff = cutoffDate();

  let year  = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(4, 6));
  const day = Number(startDate.slice(6, 8));

  if (day > 1) {
    month++;

    if (month > 12) { month = 1; year++; }
  }

  for (;;) {
    const ymd = toYMD(year, month);

    if (ymd > cutoff) break;

    dates.push(ymd);

    month++;

    if (month > 12) { month = 1; year++; }
  }

  return dates;
};

/** Computes the latest first-of-month date where date + 2 days <= now UTC. */
const cutoffDate = (): string => {
  const d = new Date();

  d.setUTCDate(d.getUTCDate() - 2);
  d.setUTCDate(1);

  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const toYMD = (year: number, month: number): string =>
  `${year}${String(month).padStart(2, '0')}01`;

const msToNextMidnightUTC = (): number => {
  const now      = new Date();
  const midnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));

  return midnight.getTime() - now.getTime();
};

// ─── test exports ──────────────────────────────────────────────────────────────
export const _test_BATCH_SIZE = BATCH_SIZE;
