import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import config from '../config';
import { monthOf } from '../dates';
import { seriesFor } from '../schema/series';
import type { Candidate } from '../types';
import type { Source } from './types';

/**
 * Trucker's tree: `<root>/<venue>/<the venue's own layout>`.
 *
 * The only structure this origin imposes is the venue directory, so the walk is
 * a plain recursive descent and every path below it is handed to the series map
 * to interpret. A path the map does not recognise is skipped in silence —
 * trucker deliberately collects more than stocker normalises.
 */
export const trucker: Source = {
  name: 'trucker',

  root: () => config.truckerDir,

  async *walk(): AsyncIterable<Candidate> {
    const root   = config.truckerDir;
    const venues = await children(root);

    for (const venue of venues) {
      if (config.venues.length && ! config.venues.includes(venue)) continue;

      for await (const absolute of descend(join(root, venue))) {
        const path     = relative(join(root, venue), absolute).split(sep).join('/');
        const resolved = seriesFor(venue, path);

        if (! resolved) continue;

        const month = monthOf(path);

        if (! month) continue;

        yield {
          path, absolute, month,
          series:    resolved.series,
          rawSymbol: resolved.symbol,
          interval:  resolved.interval,
        };
      }
    }
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

const children = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();

/**
 * Depth-first, in name order, and deliberately not parallel: this walks
 * millions of files.
 *
 * **The sort is not cosmetic.** Partitions are grouped as the walk passes them,
 * flushing when the partition changes, which only holds if a partition's files
 * arrive together. One directory holds every day of every month for a symbol,
 * and `readdir` returns entries in whatever order the filesystem likes — near
 * enough to creation order today, hash order as a directory grows, and
 * interleaved the moment two months are written at once, which four concurrent
 * downloads do at every month boundary.
 *
 * Unsorted, two interleaved months make the walk flush mid-month and build the
 * partition twice, each from a fragment, the last one overwriting the first —
 * a short partition, a ledger entry claiming it is built, and no error. Sorting
 * costs one pass over a directory listing already in memory and makes the
 * grouping independent of the filesystem rather than lucky with it.
 */
async function* descend(dir: string): AsyncIterable<string> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) yield* descend(full);
    else if (entry.isFile() && ! entry.name.endsWith('.part')) yield full;
  }
}
