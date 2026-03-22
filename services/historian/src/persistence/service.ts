import type { Db } from '@devvir/service-kit';
import type { HistoryState } from './state.js';
import type { TableConfig } from '../types.js';
import { loadAllStates, saveState } from './state.js';
import { upsertDocuments } from './writer.js';

export interface WriteResult {
  transitioned: boolean;
}

export interface SubTablePersist {
  write(rawRows: Record<string, unknown>[]): Promise<WriteResult>;
  flush(): Promise<void>;
  /**
   * Forces a block transition to recover from a BitMEX stall (see runner.ts).
   *
   * For keyless tables (idFields === null), deletes all stored rows at the current
   * lastSeenTimestamp scoped to this symbol, so they are cleanly re-fetched at the
   * start of the new block with no duplicates.
   *
   * Then advances block state: block++, blockStartTime = lastSeenTimestamp, start = 0.
   *
   * @param symbol - The fetch symbol (null for symbol-less tables). Used to scope
   *                 the delete to only this symbol's rows.
   */
  forceTransition(symbol: string | null): Promise<void>;
}

export interface PersistenceService {
  loadAllStates(): Promise<Map<string, HistoryState>>;
  bind(state: HistoryState, table: TableConfig): SubTablePersist;
  saveState(state: HistoryState): Promise<void>;
}

// Returns the timestamp string from a row, checking both 'timestamp' and 'date' fields.
const rowTimestamp = (row: Record<string, unknown>): string | null =>
  (row['timestamp'] as string | undefined) ?? (row['date'] as string | undefined) ?? null;

const addOneMs = (ts: string): string =>
  new Date(new Date(ts).getTime() + 1).toISOString();

const seqFor = (block: number, maxStart: number | null, start: number, i: number): number =>
  maxStart === null ? start + i : block * maxStart + start + i;

export const createPersistenceService = (db: Db): PersistenceService => ({
  loadAllStates: () => loadAllStates(db),

  bind: (state, table) => {
    let lastTimestamp: string | null = state.lastSeenTimestamp;

    return {
      write: async (rawRows) => {
        const inThresholdZone =
          table.maxStart !== null && state.start > table.maxStart - 1000;

        if (! inThresholdZone) {
          const docs = rawRows.map((row, i) => ({
            ...row,
            _seq: seqFor(state.block, table.maxStart, state.start, i),
          }));

          await upsertDocuments(db, table.name, table.idFields, docs);

          state.start += rawRows.length;
          state.totalFetched += rawRows.length;
          state.lastFetchedAt = new Date();
          state.lastSeenTimestamp = rowTimestamp(rawRows[rawRows.length - 1]) ?? state.lastSeenTimestamp;
          lastTimestamp = state.lastSeenTimestamp;

          await saveState(db, state);

          return { transitioned: false };
        }

        // ── Threshold zone: scan for first timestamp change ──────────────────

        let splitIndex: number | null = null;

        for (let i = 0; i < rawRows.length; i++) {
          const ts = rowTimestamp(rawRows[i]);

          if (ts === null) continue;

          if (lastTimestamp !== null && ts > lastTimestamp) {
            splitIndex = i;
            break;
          }

          lastTimestamp = ts;
        }

        const hitLimit = state.start + rawRows.length >= table.maxStart!;

        if (splitIndex === null && ! hitLimit) {
          // Still in threshold zone but no split found and not at limit — save normally.
          const docs = rawRows.map((row, i) => ({
            ...row,
            _seq: seqFor(state.block, table.maxStart, state.start, i),
          }));

          await upsertDocuments(db, table.name, table.idFields, docs);

          state.start += rawRows.length;
          state.totalFetched += rawRows.length;
          state.lastFetchedAt = new Date();
          state.lastSeenTimestamp = rowTimestamp(rawRows[rawRows.length - 1]) ?? state.lastSeenTimestamp;
          lastTimestamp = state.lastSeenTimestamp;

          await saveState(db, state);

          return { transitioned: false };
        }

        // ── Block transition ─────────────────────────────────────────────────

        let rowsToSave: Record<string, unknown>[];
        let newBlockStartTime: string;

        if (splitIndex !== null) {
          // Normal: clean split on a timestamp boundary.
          rowsToSave = rawRows.slice(0, splitIndex);
          newBlockStartTime = rowTimestamp(rawRows[splitIndex])!;
        } else {
          // Fallback: no timestamp change found — use lastTimestamp + 1ms.
          rowsToSave = rawRows;
          newBlockStartTime = addOneMs(lastTimestamp ?? rowTimestamp(rawRows[rawRows.length - 1]) ?? '');
        }

        if (rowsToSave.length > 0) {
          const docs = rowsToSave.map((row, i) => ({
            ...row,
            _seq: seqFor(state.block, table.maxStart, state.start, i),
          }));

          await upsertDocuments(db, table.name, table.idFields, docs);
        }

        state.block += 1;
        state.blockStartTime = newBlockStartTime;
        state.start = 0;
        state.totalFetched += rowsToSave.length;
        state.lastFetchedAt = new Date();
        // Seed lastSeenTimestamp to block start so resume comparison starts correctly.
        state.lastSeenTimestamp = newBlockStartTime;

        await saveState(db, state);

        lastTimestamp = newBlockStartTime;

        return { transitioned: true };
      },

      flush: () => saveState(db, state),

      forceTransition: async (symbol: string | null) => {
        // Keyless tables use insertMany, so boundary rows must be deleted before
        // re-fetch to prevent duplicates. Keyed tables use upsert — skip delete.
        if (table.idFields === null && state.lastSeenTimestamp !== null) {
          const filter: Record<string, unknown> = { timestamp: state.lastSeenTimestamp };

          if (symbol !== null) {
            filter[table.symbolField ?? 'symbol'] = symbol;
          }

          await db.collection(table.name).deleteMany(filter as never);
        }

        state.block       += 1;
        state.blockStartTime = state.lastSeenTimestamp!;
        state.start        = 0;
        lastTimestamp      = state.lastSeenTimestamp; // keep closure in sync with new block start

        await saveState(db, state);
      },
    };
  },

  saveState: (state) => saveState(db, state),
});
