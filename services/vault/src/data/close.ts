// Bucket close orchestrator.
//
// Drains the buffer for table/filename and writes it through `writeLines` with
// `seal=true`, so the writer renames `.csv.gz.tmp` → `.csv.gz` once the final
// member is written. The bucket is marked closing from the call until the seal
// settles, successfully or not; after a failed seal it accepts rows and can be
// closed again. `data/` knows about buffers and headers; `fs/` owns what
// "sealing" means.

import { buffers } from './buffers';
import { markClosing, writeLines } from './bucket';
import { isInitialized } from '../fs/writer';

/**
 * Seals the bucket. The closing mark, the buffer drain and the hand-off to the
 * writer all happen synchronously in this call; the returned promise settles
 * with the seal.
 */
export const closeBucket = async (table: string, filename: string): Promise<void> => {
  const release = markClosing(table, filename);

  try {
    const lines = buffers.get(table, filename).flush();
    buffers.remove(table, filename);

    // No open file and no buffered lines: there is nothing to seal.
    if (! isInitialized(table, filename) && lines.length === 0) return;

    await writeLines(table, filename, lines, true);
  } finally {
    release();
  }
};
