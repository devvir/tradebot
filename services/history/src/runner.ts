import { logger, type Service } from '@devvir/service-kit';
import { TABLES, PAGE_SIZE } from './utils/tables.js';
import { fetchPage, fetchFirstTimestamp } from './fetcher.js';
import { waitForPartialPage } from './utils/throttling.js';
import { buildSubTableId, makeInitialState } from './persistence/index.js';
import type { HistoryState, PersistenceService, SubTablePersist } from './persistence/index.js';
import type { Config } from './types.js';

interface RunAllTablesParams {
  states: Map<string, HistoryState>;
  instruments: string[];
  indices: string[];
  inactive: Set<string>;
}

export const runAllTables = async (service: Service, persistence: PersistenceService, { states, instruments, indices, inactive }: RunAllTablesParams): Promise<void> => {
  await Promise.all(TABLES.map((table) =>
    runTableLoop(service, persistence, { table, states, instruments, indices, inactive })
  ));
};

const runTableLoop = async (service: Service, persistence: PersistenceService, {
  table,
  states,
  instruments,
  indices,
  inactive,
}: RunAllTablesParams & { table: (typeof TABLES)[number] }): Promise<void> => {
  const config = service.config() as Config;
  const baseUrl = config.bitmexRestUrl;

  const symbols =
    table.symbolSource === 'instruments' ? instruments
    : table.symbolSource === 'indices'   ? indices
    : [null];

  const PROGRESS_INTERVAL_MS = 30_000;

  const runSymbol = async (symbol: string | null): Promise<void> => {
    const id = buildSubTableId(table.name, symbol ?? undefined);
    let lastProgressAt = 0;

    const state: HistoryState = states.get(id) ?? makeInitialState(id);

    if (! states.has(id)) {
      states.set(id, state);
    }

    // ── Complete check ───────────────────────────────────────────────────

    if (state.complete) {
      logger.debug({ subTable: id }, 'Skipping complete sub-table');
      return;
    }

    const persist = persistence.bind(state, table);

    logger.info({ subTable: id }, 'Starting sub-table fetch');

    // ── First-timestamp probe ─────────────────────────────────────────────

    if (state.firstTimestamp === null) {
      state.firstTimestamp = await fetchFirstTimestamp(baseUrl, table.path, symbol);
      logger.info({ subTable: id, firstTimestamp: state.firstTimestamp }, 'Recorded firstTimestamp');

      if (state.firstTimestamp === null && table.symbolSource !== null) {
        state.complete = true;
        await persist.flush();
        logger.info({ subTable: id }, 'Marked complete — no historical data');
        return;
      }

      await persist.flush();
    }

    // ── Page loop ─────────────────────────────────────────────────────────

    while (true) {
      const rows = await fetchPage({
        baseUrl,
        path: table.path,
        symbol,
        start: state.start,
        startTime: state.blockStartTime ?? undefined,
      });

      if (rows.length === 0) {
        // Unlisted symbols have no future data — empty page always means done.
        if (symbol !== null && inactive.has(symbol)) {
          state.complete = true;
          await persist.flush();
          logger.info({ subTable: id }, 'Marked complete — symbol is Unlisted and exhausted');
          return;
        }

        const action = await handlePartialPage(state, symbol, inactive, persist, id);

        if (action === 'complete') return;

        if (action !== 'transitioned') {
          logger.debug({ subTable: id, start: state.start }, 'Empty page — waiting for new data');
          await waitForPartialPage(symbol !== null);
        }

        continue;
      }

      const { transitioned } = await persist.write(rows);
      state.stallWarned = false;

      const now = Date.now();

      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        logger.info({ subTable: id, block: state.block, start: state.start, totalFetched: state.totalFetched }, 'Fetch progress');
        lastProgressAt = now;
      }

      if (rows.length < PAGE_SIZE && ! transitioned) {
        const action = await handlePartialPage(state, symbol, inactive, persist, id);

        if (action === 'complete') return;

        if (action !== 'transitioned') {
          logger.debug({ subTable: id, start: state.start }, 'Partial page — waiting for new data');
          await waitForPartialPage(symbol !== null);
        }
      }
    }
  };

  for (const symbol of symbols) {
    await runSymbol(symbol);
  }

  logger.info({ table: table.name }, 'Table loop complete');
};

// ── Stall detection ───────────────────────────────────────────────────────────
//
// BitMEX silently caps the number of rows returned for any given `startTime` at
// an undocumented and inconsistent internal limit (observed between ~10 000 and
// ~50 000 rows). When the cap is hit the API returns an empty or partial page
// with no error, making it indistinguishable from a legitimate "table is at tip"
// condition. The fetch loop spins on empty pages indefinitely.
//
// Detection: any page with fewer than PAGE_SIZE rows while lastSeenTimestamp is
// more than STALL_LOOKBACK_MS in the past.
//
// Recovery: delete the boundary rows from the collection and start a new block
// from that timestamp (start=0, blockStartTime=lastSeenTimestamp). This ensures:
//   - no duplicates  (boundary rows deleted before re-fetch)
//   - no gaps        (new block starts exactly at the last seen timestamp)
//   - progress       (new startTime moves past BitMEX's internal bucket boundary)
//
// Guard: if the current block already starts at lastSeenTimestamp, a new block
// would land in the same position and make no progress. Log and fall back to the
// normal wait instead — either the table is genuinely at tip or it is stuck in a
// way that force-transitioning cannot fix.

const STALL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const isStale = (timestamp: string): boolean =>
  Date.now() - new Date(timestamp).getTime() > STALL_LOOKBACK_MS;

/**
 * Called whenever a fetch returns fewer than PAGE_SIZE rows.
 *
 * Returns:
 *   'complete'     — sub-table marked done; caller must return
 *   'transitioned' — block advanced; caller must continue without waiting
 *   'waited'       — no stall detected; caller should do the normal wait
 */
const handlePartialPage = async (
  state: HistoryState,
  symbol: string | null,
  inactive: Set<string>,
  persist: SubTablePersist,
  id: string,
): Promise<'complete' | 'transitioned' | 'waited'> => {
  if (! state.lastSeenTimestamp || ! isStale(state.lastSeenTimestamp)) {
    return 'waited';
  }

  if (symbol !== null && inactive.has(symbol)) {
    state.complete = true;
    await persist.flush();
    logger.info({ subTable: id }, 'Marked complete — Unlisted symbol data exhausted (stall detected)');
    return 'complete';
  }

  if (state.blockStartTime === state.lastSeenTimestamp) {
    if (! state.stallWarned) {
      logger.warn(
        { subTable: id, blockStartTime: state.blockStartTime },
        'Stall detected but block already starts at last timestamp — cannot advance. Table may be at tip or genuinely stuck.',
      );
      state.stallWarned = true;
    }

    return 'waited';
  }

  await persist.forceTransition(symbol);

  logger.info({ subTable: id, newBlockStartTime: state.blockStartTime, block: state.block }, 'Stall detected — forced block transition');

  return 'transitioned';
};
