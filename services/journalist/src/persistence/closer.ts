import { logger } from '@devvir/service-kit';
import { WS_TABLES } from '@tradebot/utils';
import type { BitmexTable } from '../types';
import { closeVaultFile, listVaultFiles } from './vault';

const SCHEDULE_DELAY_MS = 5 * 60 * 1_000;

/**
 * Closes completed day buckets in vault. Detects per-table day transitions
 * and asks vault to close (seal) any open files for previous days.
 *
 * Two modes, decided per-detection from the incoming day:
 *   - realtime: the new day equals today (UTC). Schedules a global close
 *     across all WS tables — all tables in the stream advance together.
 *   - replay:   the new day is in the past. Schedules a close for just the
 *     one table — tables in replay are not in sync.
 *
 * `beforeClosing` is invoked right before the close hits vault (typically
 * the buffer's flushAll) so any buffered writes for the day being closed
 * land first.
 */
export const createCloser = (
  vaultUrl:      string,
  suffix:        string,
  beforeClosing: () => Promise<void>,
) => {
  const lastDay     = new Map<BitmexTable, string>();
  const tableTimers = new Map<BitmexTable, ReturnType<typeof setTimeout>>();
  let   globalTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Scheduling ────────────────────────────────────────────────────────────

  const scheduleGlobal = (): void => {
    if (globalTimer) return;

    logger.info({ delayMin: 5 }, 'Realtime day advance — global close scheduled');

    globalTimer = setTimeout(async () => {
      globalTimer = null;

      try {
        await beforeClosing();
        await closeOpenBucketsBefore([...WS_TABLES] as BitmexTable[], today());
      } catch (err) {
        logger.warn({ err }, 'Global close failed — rescheduling');
        scheduleGlobal();
      }
    }, SCHEDULE_DELAY_MS);
  };

  const scheduleTable = (table: BitmexTable): void => {
    if (tableTimers.has(table)) return;

    logger.info({ table, delayMin: 5 }, 'Replay day advance — table close scheduled');

    tableTimers.set(table, setTimeout(async () => {
      tableTimers.delete(table);

      try {
        await beforeClosing();
        await closeOpenBucketsBefore([table], lastDay.get(table)!);
      } catch (err) {
        logger.warn({ err, table }, 'Table close failed — rescheduling');
        scheduleTable(table);
      }
    }, SCHEDULE_DELAY_MS));
  };

  // ── Closing ───────────────────────────────────────────────────────────────

  // Closes every open bucket strictly before `day` for the given tables.
  // Throws if listing fails; close calls retry internally in vault.ts.
  const closeOpenBucketsBefore = async (tables: BitmexTable[], day: string): Promise<void> => {
    let closed = 0;

    for (const table of tables) {
      const listing = await listVaultFiles(vaultUrl, table, suffix);

      if (! listing) continue;

      for (const [stem, state] of Object.entries(listing)) {
        if (state !== 'open') continue;

        // Vault lists stems as `${date}.${suffix}` when a suffix is set; the
        // close endpoint expects the bare date in the path and re-composes
        // the suffix from `?suffix=`. Strip here to avoid a double-suffix.
        const date = suffix ? stem.slice(0, -(suffix.length + 1)) : stem;

        if (date >= day) continue;

        logger.info({ table, date }, 'Closing vault bucket');
        await closeVaultFile(vaultUrl, table, date, suffix);
        closed++;
      }
    }

    logger.info({ tables: tables.length, day, closed }, 'Close pass complete');
  };

  // ── Entry point ───────────────────────────────────────────────────────────

  /**
   * Records the day of an incoming message for a table. When a strictly
   * later day is observed (or the very first day for that table after
   * startup), schedules a close pass — global for realtime, per-table for
   * replay.
   */
  const track = (table: BitmexTable, day: string): void => {
    const prev = lastDay.get(table);

    if (prev && day <= prev) return;

    lastDay.set(table, day);

    const mode = day === today() ? 'realtime' : 'replay';

    if (prev) logger.info({ table, day, prev, mode }, 'New day for table');

    if (mode === 'realtime') scheduleGlobal();
    else                     scheduleTable(table);
  };

  return { track };
};

const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '');
