import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import config from './config';
import { labelOf } from './partition';
import type { Built, RawFile } from './types';

/**
 * A record of settled data changing after the fact.
 *
 * A partition is built only once its collector publishes the month as finished,
 * and "finished" is a promise that the month will not change. When it changes
 * anyway — a raw file appearing under a month already normalised — the rebuild
 * itself is automatic and harmless, but the *fact* is not: the same month may
 * already be in cold storage, mirrored offsite, or read by something that was
 * told it was immutable.
 *
 * So it is written where a human will find it, beside the collector's own
 * record of venues rewriting history. Neither service acts on these; they exist
 * so a person can decide whether a tarball needs rebuilding or a downstream
 * consumer re-reading.
 *
 * Additions are what this catches. A file *removed* leaves the remaining inputs
 * matching what was recorded and passes unnoticed — deliberately, since nothing
 * deletes raw archives and guarding against it would mean re-`stat`ing every
 * input of every settled partition on every sweep.
 */

const DIR = 'rebuilt';

/**
 * Note that a built partition's inputs no longer match what it was built from,
 * and say so loudly.
 *
 * The log line is what gets noticed while watching a sweep; the file is what
 * survives the log being rotated away, which for something that may need acting
 * on days later is the part that matters.
 */
export const flag = async (record: Built, inputs: readonly RawFile[]): Promise<void> => {
  const known = new Map(record.inputs.map(input => [input.path, input.size] as const));
  const added = inputs.filter(input => known.get(input.path) !== input.size);

  if (added.length === 0) return;

  const { table, venue, market, symbol, month } = record.key;
  const at   = new Date().toISOString();
  const path = join(config.sharedDir, DIR, `${venue}.tsv`);

  logger.warn({
    partition: labelOf(record.key),
    added:     added.length,
    first:     added[0]!.path,
    builtAt:   record.builtAt,
  }, 'Settled month changed after it was built — rebuilding, see @shared/rebuilt');

  await mkdir(join(config.sharedDir, DIR), { recursive: true });
  await appendFile(path,
    [table, venue, market, symbol, month, added.length, added[0]!.path, record.builtAt, at]
      .join('\t') + '\n');
};
