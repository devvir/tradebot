import fs from 'node:fs';
import path from 'node:path';
import { discard } from '../discard';
import { Archives } from '../../shared/disk';
import { idOf, partitionOf } from '../../shared/keys';
import { meter } from '../../shared/meter';
import * as record from '../../shared/record';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin } from '../../types';
import type { Evictable } from '../types';

/**
 * Remove one venue's evictable partitions from disk — to the trash, or outright
 * where `purge` says so — and write down each as it goes.
 *
 * **A directory goes whole wherever everything in it is going.** A month's
 * directory under an instrument holds every rendering of that month side by
 * side, and each rendering is a partition of its own, in cold storage or not.
 * Where every file in a directory belongs to a partition being evicted in this
 * run, the directory is one thing to move. Only where something in it is
 * staying — a rendering not stored yet, a file that is nobody's — are the
 * partition's files picked out of it by name. Moving a directory is one move
 * for the thirty files in it, which is most of what removing a month of small
 * files costs.
 *
 * **Only here is the disk read, and only for names.** No file is opened or
 * measured. What is written down is how many files went, and what the catalog
 * says the partition weighs.
 *
 * A partition whose files would not go to the trash stops the run where it is:
 * nothing of it is written down, and nothing is deleted in its place.
 */
export const remove = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  found:    Evictable,
  archives: Archives,
  purge:    boolean,
): Promise<{ files: number; bytes: number }> => {
  const total = { files: 0, bytes: 0 };
  const going = new Set(found.ready.map(idOf));

  /** Files removed for each partition so far: a directory taken whole takes its other renderings' files with it. */
  const took = new Map<string, number>();

  let done = 0;

  /**
   * One line for the venue, rewritten as each partition goes: a venue is
   * hundreds of partitions and a million files, and minutes of nothing said
   * reads as nothing happening.
   */
  const show = (): void => {
    if (! process.stdout.isTTY) return;

    process.stdout.write(`\r\x1b[K  ${found.venue.padEnd(8)} ${meter((done / found.ready.length) * 100)} `
      + `${done}/${found.ready.length} partitions · ${total.files.toLocaleString('en-US')} files`);
  };

  show();

  for (const partition of found.ready) {
    const mine   = idOf(partition);
    const whole: string[] = [];
    const single: string[] = [];

    for (const { dir, names } of await archives.monthDirsOf(partition)) {
      const owners = names.map(name => { const key = partitionOf(name); return key ? idOf(key) : null; });

      if (owners.every(owner => owner !== null && going.has(owner))) {
        whole.push(dir);

        for (const owner of owners) took.set(owner!, (took.get(owner!) ?? 0) + 1);

        continue;
      }

      for (const [at, name] of names.entries())
        if (owners[at] === mine) {
          single.push(path.join(dir, name));
          took.set(mine, (took.get(mine) ?? 0) + 1);
        }
    }

    await discard([...whole, ...single].map(one => path.join(config.sourceRoot, one)), purge);

    // The directories this emptied go too, upward as far as they are empty: a month's where the
    // files were picked out of it, then the instrument's, its letter's, the dataset's and the market's.
    for (const dir of new Set([...whole.map(one => path.dirname(one)), ...single.map(file => path.dirname(file))]))
      prune(config.sourceRoot, dir);

    const files = took.get(mine) ?? 0;

    record.noteEviction(db, origin, partition, { files, bytes: partition.bytes });

    total.files += files;
    total.bytes += partition.bytes;

    done++;
    show();
  }

  // The line is the caller's to finish: it says what the venue came to.
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');

  return total;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Remove a directory and each one above it for as long as they are empty,
 * never the venue's own. A directory that holds anything is left, and so is
 * everything above it: `rmdir` refuses it, which is the whole of the check.
 */
const prune = (root: string, dir: string): void => {
  for (let at = dir; at.split(path.sep).length > 1; at = path.dirname(at)) {
    try {
      fs.rmdirSync(path.join(root, at));
    } catch {
      return;
    }
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_remove = remove;
