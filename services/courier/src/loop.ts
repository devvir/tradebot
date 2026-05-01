import { logger } from '@devvir/service-kit';
import config from './config';
import type { Table } from './types';
import { fetchAndStore, listVaultDates } from './download';

const DEFAULT_START_DATE = '20141122';
const TABLES: Table[] = ['trade', 'quote'];

// ── Entry point ───────────────────────────────────────────────────────────────

export const runLoop = async (vaultUrl: string): Promise<void> => {
  await syncAll(vaultUrl);

  scheduleNextPoll(vaultUrl);
};

// ── Sync operations ───────────────────────────────────────────────────────────

export const syncAll = async (vaultUrl: string): Promise<void> => {
  for (const table of TABLES) {
    await syncTable(vaultUrl, table);
  }
};

// Fetches all dates not yet in vault for a given table, in chronological order.
export const syncTable = async (vaultUrl: string, table: Table): Promise<void> => {
  const existing = new Set(await listVaultDates(vaultUrl, table));
  const startDate = config.startDate ?? DEFAULT_START_DATE;
  const needed   = dateRange(startDate, yesterdayUTC());
  const missing  = needed.filter(d => ! existing.has(d));

  if (missing.length === 0) {
    logger.info({ table }, 'All dates present in vault');
    return;
  }

  logger.info({ table, count: missing.length }, 'Downloading missing dates');

  for (const date of missing) {
    await fetchAndStore(vaultUrl, table, date);
  }
};

// ── Midnight scheduling ───────────────────────────────────────────────────────
//
// Self-rescheduling timer that fires at the next UTC midnight. Each tick
// re-runs syncAll to pick up the newly available prior-day dump.

const scheduleNextPoll = (vaultUrl: string): void => {
  logger.info('All files downloaded, will rescan in a few hours');

  setTimeout(async () => {
    logger.info('Checking for new files');

    await syncAll(vaultUrl).catch(err => logger.error({ err }, 'Sync error'));

    scheduleNextPoll(vaultUrl);
  }, 3 * 60 * 60 * 1000); // 3 hours
};

// ── Date utilities ─────────────────────────────────────────────────────────────

const yesterdayUTC = (): string => {
  const d = new Date();

  d.setUTCDate(d.getUTCDate() - 1);

  return toYMD(d);
};

const dateRange = (from: string, to: string): string[] => {
  const dates: string[] = [];
  const d               = fromYMD(from);
  const end             = fromYMD(to);

  while (d <= end) {
    dates.push(toYMD(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return dates;
};

const toYMD = (d: Date): string =>
  d.toISOString().slice(0, 10).replace(/-/g, '');

const fromYMD = (ymd: string): Date =>
  new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`);
