// Per-bucket write path: header handling and lifecycle state.
//
// A bucket is the file for one `table/filename`. `writeLines` is how lines
// reach a bucket's file: when the file does not exist yet, the table's header
// line is written ahead of the lines. The closing state marks buckets whose
// seal is in progress; a bucket in that state accepts no rows.

import { headersFor } from './headers';
import { appendBatch, isInitialized } from '../fs/writer';

// Per-key count of seals in progress. A count rather than a flag so that
// overlapping closes of one bucket release it only when the last one settles.
const closing = new Map<string, number>();

/**
 * Appends `lines` to the bucket's file, preceded by the table's header line
 * when the file does not exist yet, and seals the file when `seal` is true.
 * The header decision and the hand-off to the writer happen synchronously in
 * this call, so the first of several back-to-back calls for a new file is the
 * only one that writes the header.
 *
 * Rejects (never throws) when the table has no header definition or the write
 * fails.
 */
export const writeLines = async (
  table:    string,
  filename: string,
  lines:    string[],
  seal:     boolean = false,
): Promise<void> => {
  const finalLines = isInitialized(table, filename)
    ? lines
    : [headerLine(table), ...lines];

  return appendBatch(table, filename, finalLines, seal);
};

/**
 * Marks the bucket as closing until the returned release function is called.
 * Calling release more than once has no further effect.
 */
export const markClosing = (table: string, filename: string): (() => void) => {
  const key = `${table}/${filename}`;

  closing.set(key, (closing.get(key) ?? 0) + 1);

  let released = false;

  return () => {
    if (released) return;

    released = true;

    const left = (closing.get(key) ?? 1) - 1;

    if (left > 0) closing.set(key, left);
    else closing.delete(key);
  };
};

/** True while a seal of the bucket is in progress. */
export const isClosing = (table: string, filename: string): boolean => {
  return closing.has(`${table}/${filename}`);
};

/** Whether the bucket's lifecycle state allows new rows to be buffered for it. */
export const acceptsRows = (table: string, filename: string): boolean => {
  return ! isClosing(table, filename);
};

const headerLine = (table: string): string => {
  const cols = headersFor(table);

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  return cols.join(',');
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { closing.clear(); };
