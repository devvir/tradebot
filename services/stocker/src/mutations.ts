import { join } from 'node:path';
import { logger } from '@devvir/service-kit';
import { FactManager } from '@tradebot/pipeline';
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
 * So it is kept where a human will find it, beside the collector's own record of
 * venues rewriting history. Neither service acts on these; they exist so a
 * person can decide whether a tarball needs rebuilding or a downstream consumer
 * re-reading.
 *
 * **`logs:` because this is an occurrence, not a state.** Every other fact
 * stocker states describes how something *is*, and re-stating it replaces what
 * was there. A partition drifting from its inputs happened, can happen again,
 * and every time it did is worth keeping — a partition that has drifted three
 * times is saying something one that drifted once is not. `seq` carries the
 * moment, which both separates the occurrences and orders them.
 *
 * Additions are what this catches. A file *removed* leaves the remaining inputs
 * matching what was recorded and passes unnoticed — deliberately, since nothing
 * deletes raw archives and guarding against it would mean re-`stat`ing every
 * input of every settled partition on every sweep.
 */

let store: FactManager | null = null;

const facts = (): FactManager =>
  (store ??= new FactManager({ owner: 'stocker', root: join(config.sharedDir, 'facts') }));

/**
 * Note that a built partition's inputs no longer match what it was built from,
 * and say so loudly.
 *
 * The log line is what gets noticed while watching a sweep; the record is what
 * survives the container the log lived in, which for something that may need
 * acting on months later is the part that matters.
 */
export const flag = async (record: Built, inputs: readonly RawFile[]): Promise<void> => {
  const known = new Map(record.inputs.map(input => [input.path, input.size] as const));
  const added = inputs.filter(input => known.get(input.path) !== input.size);

  if (added.length === 0) return;

  const { table, venue, market, symbol, month } = record.key;

  logger.warn({
    partition: labelOf(record.key),
    added:     added.length,
    first:     added[0]!.path,
    builtAt:   record.builtAt,
  }, 'Settled month changed after it was built — rebuilding, recorded under logs:vault');

  // `append` fills `seq` with the moment, so occurrences accumulate under one
  // key instead of the newest replacing the last.
  facts().append({
    topic: 'logs:vault', venue, period: month.replace('-', ''),
    market, symbol, dataset: table, fact: 'drifted',
    value: String(added.length),
    meta:  { first: added[0]!.path, builtAt: record.builtAt },
  });
};

/** Close the store. The service holds it open for its lifetime otherwise. */
export const close = (): void => {
  store?.close();
  store = null;
};
