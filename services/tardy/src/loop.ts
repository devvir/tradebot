import { logger } from '@devvir/service-kit';
import config from './config';
import type { TardyTable, WsMessage } from './types';
import { streamDate } from './tardis';
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

const BATCH_SIZE = 10_000;

// ── Entry point ───────────────────────────────────────────────────────────────

export const runLoop = async (vaultUrl: string): Promise<void> => {
  await syncAll(vaultUrl);

  scheduleNextPoll(vaultUrl);
};

// ── Sync ──────────────────────────────────────────────────────────────────────

export const syncAll = async (vaultUrl: string): Promise<void> => {
  const dates = targetDates(config.startDate);

  logger.info({ count: dates.length }, 'Checking target dates');

  for (const date of dates) {
    await syncDate(vaultUrl, date);
  }

  logger.info('Sync complete');
};

/**
 * For a single date, determines which tables still need data, streams from
 * Tardis, and writes to vault. Skips the date entirely if all tables are
 * already closed.
 */
export const syncDate = async (vaultUrl: string, date: string): Promise<void> => {
  const needed = await resolveTables(vaultUrl, date);

  if (needed.length === 0) return;

  logger.info({ date, tables: needed }, 'Fetching from Tardis');

  const batches = new Map<TardyTable, WsMessage[]>(
    needed.map(t => [t, []]),
  );

  for await (const { table, msg } of streamDate(date, needed)) {
    const buf = batches.get(table)!;

    buf.push(msg);

    if (buf.length >= BATCH_SIZE) {
      await writeRows(vaultUrl, table, date, buf.splice(0));
    }
  }

  // Flush remaining messages and close each table's file.
  for (const table of needed) {
    const buf = batches.get(table)!;

    if (buf.length > 0) {
      await writeRows(vaultUrl, table, date, buf);
    }

    await closeFile(vaultUrl, table, date);

    logger.info({ table, date }, 'Closed');
  }
};

// ── Table resolution ──────────────────────────────────────────────────────────

/**
 * Queries vault for each table and returns only those that need downloading.
 * Deletes any open files first (crash recovery) and excludes closed ones.
 */
const resolveTables = async (vaultUrl: string, date: string): Promise<TardyTable[]> => {
  const needed: TardyTable[] = [];

  for (const table of TABLES) {
    const files = await listFiles(vaultUrl, table);
    const state = files[date];

    if (state === 'closed') continue;

    if (state === 'open') {
      logger.info({ table, date }, 'Deleting open file (recovery)');
      await deleteFile(vaultUrl, table, date);
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
