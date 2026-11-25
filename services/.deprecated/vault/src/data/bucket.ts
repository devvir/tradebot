// Per-bucket write path: header handling and lifecycle state.
//
// A bucket is the file for one `table/filename`. `writeLines` is how lines
// reach a bucket's file: when the file does not exist yet, the table's header
// line is written ahead of the lines. `discardBucket` drops a bucket's buffered
// rows and open file; `uploadBucket` does the same and then stores a complete
// file for it.
//
// Lifecycle state, per bucket (`bucketState`):
//   - closing     a seal is in progress; overlapping seals are allowed.
//   - discarding  a discard is in progress.
//   - uploading   an upload is in progress.
//   - idle        none of the above.
// Only an idle bucket accepts rows. A discard or an upload starts only on an
// idle bucket and holds it exclusively until it settles, so nothing writes the
// bucket's open file while it is being removed or replaced.

import type { Readable } from 'stream';
import { headersFor } from './headers';
import { buffers } from './buffers';
import { appendBatch, isInitialized, deleteFile, storeFile } from '../fs/writer';

export type BucketState = 'idle' | 'closing' | 'discarding' | 'uploading';

/** The bucket's lifecycle state does not allow the requested operation. */
export class BucketBusyError extends Error {}

// Per-key count of seals in progress. A count rather than a flag so that
// overlapping closes of one bucket release it only when the last one settles.
const closing = new Map<string, number>();

// Per-key exclusive operation in progress.
const exclusive = new Map<string, 'discarding' | 'uploading'>();

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
 * Drops the bucket's buffered rows and its open file, including members still
 * queued for it. Rejects with BucketBusyError, changing nothing, unless the
 * bucket is idle; the bucket is `discarding` from the call until the returned
 * promise settles.
 */
export const discardBucket = async (table: string, filename: string): Promise<void> => {
  const release = claim(table, filename, 'discarding');

  try {
    await dropOpenFile(table, filename);
  } finally {
    release();
  }
};

/**
 * Drops the bucket's buffered rows and open file as `discardBucket` does, then
 * stores `source` as its closed file (see `storeFile` for validation and the
 * errors it rejects with). Rejects with BucketBusyError, changing nothing and
 * leaving `source` unread, unless the bucket is idle; the bucket is
 * `uploading` from the call until the returned promise settles.
 */
export const uploadBucket = async (table: string, filename: string, source: Readable): Promise<void> => {
  const release = claim(table, filename, 'uploading');

  try {
    await dropOpenFile(table, filename);
    await storeFile(table, filename, source);
  } finally {
    release();
  }
};

/** The bucket's current lifecycle state. */
export const bucketState = (table: string, filename: string): BucketState => {
  const key = `${table}/${filename}`;

  return exclusive.get(key) ?? (closing.has(key) ? 'closing' : 'idle');
};

/**
 * Marks the bucket as closing until the returned release function is called.
 * Calling release more than once has no further effect. Throws BucketBusyError
 * while the bucket is discarding or uploading.
 */
export const markClosing = (table: string, filename: string): (() => void) => {
  const key   = `${table}/${filename}`;
  const state = bucketState(table, filename);

  if (state === 'discarding' || state === 'uploading')
    throw new BucketBusyError(`Bucket ${key} is ${state}`);

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
  return bucketState(table, filename) === 'idle';
};

const claim = (table: string, filename: string, op: 'discarding' | 'uploading'): (() => void) => {
  const key   = `${table}/${filename}`;
  const state = bucketState(table, filename);

  if (state !== 'idle') throw new BucketBusyError(`Bucket ${key} is ${state}`);

  exclusive.set(key, op);

  return () => { exclusive.delete(key); };
};

const dropOpenFile = async (table: string, filename: string): Promise<void> => {
  buffers.remove(table, filename);

  await deleteFile(table, filename);
};

const headerLine = (table: string): string => {
  const cols = headersFor(table);

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  return cols.join(',');
};

// ── Test helpers ──────────────────────────────────────────────────────────────

export const _test_reset = (): void => { closing.clear(); exclusive.clear(); };
