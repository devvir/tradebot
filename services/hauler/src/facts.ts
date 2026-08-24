import { join } from 'node:path';
import { FactManager } from '@tradebot/pipeline';
import type { FactKey } from '@tradebot/pipeline';
import config from './config';
import type { Partition } from './types';

/**
 * The one thing hauler tells the rest of the pipeline.
 *
 * **Almost nothing needs publishing, because the catalog already knows it.**
 * Which files were downloaded, when, their sizes and etags all live there, per
 * file, and copying any of it here would be a second copy of a live table — free
 * to disagree with the first and with nothing to say which was right.
 *
 * What is *not* derivable from anywhere is when hauler considered a partition
 * finished. So that is the fact, and one timestamp is enough to replace every
 * membership list downstream: stocker stores the completion time it built
 * against, and a newer one means the partition was rebuilt and its own output is
 * stale. A venue republishing a file clears its `downloaded_at` in the catalog,
 * the partition stops being complete, and the whole chain follows with no
 * special case anywhere.
 */

/** State that a partition is finished, as of now. */
export const complete = (partition: Partition): void => {
  facts().record({ ...keyOf(partition), value: new Date().toISOString() });
};

/** When a partition was last called complete, or `null` if it never was. */
export const completedAt = (partition: Partition): string | null =>
  facts().value(keyOf(partition));

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * What identifies one partition's completion.
 *
 * **The variants go in `subject`**, which is for what only the owner knows the
 * shape of: `1m` means something to klines and nothing to anybody else, so it
 * belongs there rather than in a column every other topic would leave blank.
 * `dataset` keeps the bare table name, so asking for every kline partition of a
 * venue needs no pattern matching.
 */
const keyOf = (partition: Partition): FactKey => {
  const [dataset = '', ...levels] = partition.dataset.split(',');

  return {
    topic:   'archives',
    venue:   partition.venue,
    period:  partition.month,
    market:  partition.market,
    dataset,
    subject: levels.join(','),
    fact:    'complete',
  };
};

/**
 * The one handle on the facts database, shared by everything here.
 *
 * **One manager, because it is one set of open databases.** A second instance
 * over the same directory would be a second connection to the same files,
 * writing the same rows, for no benefit at all.
 */
export const manager = (): FactManager =>
  (store ??= new FactManager({ owner: 'hauler', root: join(config.sharedDir, 'facts') }));

let store: FactManager | null = null;

const facts = manager;
