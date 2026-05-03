import type { StoreService } from './store';

type Row = Record<string, unknown>;

export interface BufferedWriter {
  push(row: Row):  Promise<void>;
  close():         Promise<void>;
}

/**
 * Buffers rows and flushes to vault in batches of `flushThreshold`, keeping at
 * most one write in flight. The fetch loop only blocks on `push` when vault is
 * slower than fetching — otherwise the next batch is collected in parallel
 * with the previous write.
 */
export const createBufferedWriter = (
  store:          StoreService,
  table:          string,
  date:           string,
  flushThreshold: number,
): BufferedWriter => {
  let buffer:  Row[]                = [];
  let pending: Promise<void> | null = null;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;

    if (pending) await pending;

    const batch = buffer;
    buffer  = [];
    pending = store.writeRows(table, date, batch);
  };

  return {
    push: async (row) => {
      buffer.push(row);

      if (buffer.length >= flushThreshold) await flush();
    },

    close: async () => {
      await flush();
      if (pending) await pending;
    },
  };
};
