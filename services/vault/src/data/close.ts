// Bucket close orchestrator.
//
// Drains the buffer for table/date, prepends the header if the file is not
// yet initialised on disk, and hands the result to `fs/writer.appendBatch`
// with `seal=true` so the writer renames `.csv.gz.tmp` → `.csv.gz` once the
// final member is written. `data/` knows about buffers and headers; `fs/`
// owns what "sealing" means.

import { buffers } from './buffers';
import { TABLE_HEADERS } from './headers';
import { appendBatch, isInitialized } from '../fs/writer';

export const closeBucket = (table: string, date: string): Promise<void> => {
  const lines       = buffers.get(table, date).flush();
  const initialised = isInitialized(table, date);

  if (! initialised && lines.length === 0) {
    // Nothing to do — no open file, no buffered lines.
    return Promise.resolve();
  }

  const finalLines = initialised
    ? lines
    : [headerLine(table), ...lines];

  return appendBatch(table, date, finalLines, true);
};

const headerLine = (table: string): string => {
  const cols = TABLE_HEADERS[table];

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  return cols.join(',');
};
