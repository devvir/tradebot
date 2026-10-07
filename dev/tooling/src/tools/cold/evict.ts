import fs from 'node:fs';
import path from 'node:path';
import * as catalog from './catalog';
import { SETTLE_DAYS, WATCH_MS, loadConfig } from './config';
import { onExit } from './cleanup';
import { discard } from './discard';
import { Archives } from './disk';
import { idOf, partitionOf } from './keys';
import { acquire } from './lock';
import { agreed, isWatch } from './options';
import { meter } from './progress';
import * as record from './record';
import { ERRORS, LEDGER, MISSING, errorsIn, filesOf, stockedIn } from './vault';
import { fmtBytes } from '../../shared/utils/format';
import { error, info, spacer, success } from '../../shared/ui/logger';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, ColdConfig, EvictOptions, Evictable, HeldBack, Origin, PartitionKey, Run, Stocked } from './types';

/**
 * Take off the local disk what no longer has to be there.
 *
 * **A partition of the archives can go once two things hold it**: cold storage,
 * at the version the catalog has, and the vault, stocked from it. The archives
 * exist to be stocked and to be kept; once both are done the copy on disk is a
 * third.
 *
 * What is asked of each settled partition the catalog says is downloaded:
 *
 * - **It is in cold storage at the catalog's version.** That it was checked
 *   against the disk and proven inside its tar is what storing it meant, so
 *   nothing is compared again here — **and nothing on disk is looked at**.
 *   Whatever the archives hold of such a partition goes: the same files, older
 *   ones, or some of them. No answer the disk could give changes that, so it is
 *   not asked, and deciding what can go costs no walk over the tree.
 * - **It is stocked** — it, or any other rendering of the same data: another
 *   grain, or the market's bundle. Which rendering the vault was built from is
 *   the vault's business; what matters is that none is needed any more. The
 *   vault's ledger says so, and says it only while the versions it was stocked
 *   from are still the catalog's — and only while what was stocked is still
 *   held somewhere: in cold storage, as the record says, or on disk in the
 *   vault.
 * - **No neighbouring month still needs it.** Where a venue cuts its days away
 *   from UTC midnight, a month's first or last hours sit in a file of the month
 *   next door, and the vault stocks them from there. A month's own ledger line
 *   says whether its dataset does that, and which way: a side it names — with
 *   the neighbour's version, or as `missing` — is a side a neighbour's files
 *   hold. A month whose last hours are in the next month's files has files
 *   that hold the last hours of the month before; so they stay until the month
 *   before has them, which its own line says. A month whose line names no side
 *   is in nobody's way.
 *
 * **A month stocked without a neighbour's hours is stocked.** Its own files
 * have given the vault everything they hold, and what it lacks is in the
 * neighbour's.
 *
 * **Only a month the catalog holds is waited for.** A neighbour the venue
 * published nothing in will never need anything. The one exception is a month
 * whose files hold the first hours of the month after, where that month is not
 * in the catalog yet and has not had its time: a month can be settled
 * `SETTLE_DAYS` after it ends, so until then not published is not ended.
 *
 * **What is removed goes to the host's trash**, never straight to nothing.
 * Every check above has to be right for a removal to be safe, and the one thing
 * none of them covers is a mistake in the checks. The trash is on the same
 * volume, so it is a rename; it frees no space until it is emptied, which is
 * the chance to look at what was taken. A trash that fails is never retried as
 * a delete. `purge` removes outright, for when that is what is wanted.
 *
 * **What was evicted and is on disk again is not looked for, unless asked.**
 * The record says a partition went, at the version it has now, and it is not
 * offered again — files brought back since, pulled from cold storage to be read
 * or fetched some other way, are nobody's to remove. `cleanup` looks: for every
 * partition that went and could still go by every rule above, it reads the
 * disk, and whatever of the partition is there goes again. Cold storage holds
 * the version the catalog has, so what is on disk is spare whatever it is — the
 * same files, older ones, or half of them. It is a look taken on purpose and
 * once: never while watching, where it would take files as they are pulled.
 *
 * **Nothing is evicted while the vault reports a loss.** `ERROR.log` in the
 * vault means its ledger said something its disk did not bear out — and the
 * ledger is what this trusts.
 */
export const runEvict = async (origin: Origin, options: EvictOptions): Promise<void> => {
  if (options.cleanup && isWatch()) {
    error('--cleanup looks at the disk once and removes what it finds; it does not run with --watch');

    process.exitCode = 1;

    return;
  }

  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'evict');

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const venues   = options.venues.length > 0 ? options.venues : await catalog.venues(config);
      const archives = new Archives(config.sourceRoot);
      const run: Run = { config, origin, venues, archives, options, agreed: false, waiting: false };

      /**
       * **Watching, the same is asked again at intervals.** What can go changes
       * as partitions are stored and stocked, so a run left going removes each
       * as it becomes removable. It asks before the first removal and not
       * again: the answer was to the kind of thing being removed, and that does
       * not change between one look and the next.
       */
      for (let first = true; ; first = false) {
        if (! await pass(db, run, first)) return;

        if (! isWatch()) return;

        await new Promise(resolve => setTimeout(resolve, WATCH_MS));
      }
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Look once at what can go, and remove it. Says whether the run goes on: false
 * where it was refused, could not be answered, or was told no.
 *
 * **The first look says everything it finds; a later one only what it has to
 * do.** A run that is watching and finds nothing says so once, and then stays
 * quiet until there is something.
 */
const pass = async (db: DatabaseSync, run: Run, first: boolean): Promise<boolean> => {
  const { config, origin, venues, options } = run;

  // Read on every look: the vault is stocked while this runs, and may report a loss while it does.
  const lost = errorsIn(config.vaultRoot);

  if (lost.length > 0) {
    error(`The vault reports ${lost.length} problem${lost.length === 1 ? '' : 's'} in ${path.join(config.vaultRoot, ERRORS)} — `
      + 'nothing is evicted until that is understood and the file is gone');

    for (const line of lost.slice(0, 5)) info(`  ${line}`);

    process.exitCode = 1;

    return false;
  }

  const stocked = stockedIn(config.vaultRoot);

  if (! stocked) {
    error(`No ${LEDGER} in ${config.vaultRoot} — without the vault's ledger nothing can be said to be stocked. Is VAULT_DIR right?`);

    process.exitCode = 1;

    return false;
  }

  const found: Evictable[] = [];

  if (first) info('Asking what in the archives is stored and stocked');

  try {
    for (const venue of venues) {
      const one = await survey(db, config, origin, venue, stocked, Date.now(), options.cleanup ? run.archives : undefined);

      found.push(one);

      if (first) info(`  ${venue.padEnd(8)} ${said(one)}`);
    }
  } catch (err) {
    // A catalog that does not answer ends a single look, and costs a watching run only this one.
    if (first || ! isWatch()) throw err;

    info(`Could not ask the catalog: ${(err as Error).message}`);

    return true;
  }

  const ready = found.flatMap(one => one.ready);

  if (ready.length === 0) {
    if (! isWatch()) success('Nothing in the archives can be evicted');
    else if (! run.waiting) info('Watch mode - Waiting for new partitions to evict');

    run.waiting = true;

    return true;
  }

  run.waiting = false;

  if (! first)
    for (const one of found)
      if (one.ready.length > 0) info(`  ${one.venue.padEnd(8)} ${said(one)}`);

  spacer();
  info(loadOf(ready));
  spacer();

  if (options.dryRun) return true;

  const purge = options.purge ?? false;

  if (! run.agreed && ! await agreed(purge ? 'Delete them from disk?' : 'Move them to the trash?', false)) return false;

  run.agreed = true;

  let bytes = 0;

  for (const one of found) {
    if (one.ready.length === 0) continue;

    const removed = await remove(db, config, origin, one, run.archives, purge);

    bytes += removed.bytes;

    info(`  ${one.venue.padEnd(8)} ${removed.files.toLocaleString('en-US')} files ${purge ? 'deleted' : 'moved to the trash'} · ${fmtBytes(removed.bytes)}`);
  }

  spacer();
  success('Evicted. What was removed is in cold storage and in the vault.');

  if (! purge) info(`${fmtBytes(bytes)} is reclaimed once the trash is emptied — nothing is freed until then`);

  // Done for now, and said: the next look is half an hour away.
  if (isWatch()) {
    info('Watch mode - Waiting for new partitions to evict');

    run.waiting = true;
  }

  return true;
};

/**
 * What of one venue's archives can go, and what stays and why.
 *
 * The catalog is asked twice: for the partitions that are downloaded and
 * settled, which are the candidates, and for every partition it holds, which
 * says what each one's version is now and which months a dataset has.
 *
 * The record says which of them have gone already, at the version they have
 * now, so that what was evicted is not offered again. The disk says nothing,
 * and is not asked — unless `returned` is given: then each partition that went
 * is looked for there, and goes again where any file of it is back.
 */
const survey = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  venue:    string,
  stocked:  readonly Stocked[],
  now:      number = Date.now(),
  returned?: Archives,
): Promise<Evictable> => {
  const all        = await catalog.partitions(config, venue);
  const candidates = await catalog.partitions(config, venue, { downloaded: 'true', settled: 'true' });

  const versions = new Map(all.map(one => [idOf(one), one.version]));
  const inCold   = new Map(record.storedOf(db, origin, venue).map(one => [idOf(one), one.version]));
  const evicted  = record.evictedOf(db, origin, venue);

  /** The months each dataset has anything in, whatever the rendering. */
  const months = new Map<string, Set<string>>();

  for (const one of all) months.set(dataOf(one), (months.get(dataOf(one)) ?? new Set()).add(one.month));

  /** The ledger's lines by the data they hold: a dataset's month, in whichever rendering it was stocked from. */
  const lines = new Map<string, Stocked[]>();

  for (const one of stocked) {
    if (one.source.venue !== venue) continue;

    const at = `${dataOf(one.source)}|${one.source.month}`;

    lines.set(at, [...lines.get(at) ?? [], one]);
  }

  /**
   * **The vault's own copy has to be somewhere**: in cold storage, as the record
   * says, or on disk. The record is asked first and answers without touching
   * anything; only a partition it does not have stored is looked for in the
   * vault, and each one once.
   */
  const vaultStored = record.vaultStored(db);
  const found       = new Map<string, boolean>();

  const held = (one: Stocked): boolean => {
    if (vaultStored.get(one.partition)?.has(one.revision)) return true;

    if (! found.has(one.partition)) found.set(one.partition, filesOf(config.vaultRoot, one) !== null);

    return found.get(one.partition)!;
  };

  /** Whether a side a line names is as the catalog has it: not named, not there to be read, or the neighbour's version still. */
  const sideHolds = (one: Stocked, side: string, by: number): boolean =>
    ! side || side === MISSING || versions.get(idOf({ ...one.source, month: shift(one.source.month, by) })) === side;

  /** Whether the versions a line was stocked from are still the catalog's, and what was stocked is still held. */
  const current = (one: Stocked): boolean =>
    versions.get(idOf(one.source)) === one.version
    && sideHolds(one, one.preVersion, -1)
    && sideHolds(one, one.postVersion, 1)
    && held(one);

  /** The line a month of a dataset is stocked by, in whichever rendering; nothing where it is not stocked. */
  const lineOf = (data: string, month: string): Stocked | undefined =>
    (lines.get(`${data}|${month}`) ?? []).find(current);

  const out: Evictable = {
    venue, ready: [], gone: 0, returned: 0,
    held: { 'not in cold storage': 0, 'not stocked': 0, 'a neighbouring month still needs it': 0 },
  };

  for (const one of candidates) {
    const why = heldBack(one, inCold, months.get(dataOf(one)) ?? new Set(), lineOf, settlable(now));

    if (why) {
      out.held[why]++;

      continue;
    }

    if (evicted.get(idOf(one)) !== one.version) {
      out.ready.push(one);
    } else if (returned && await isBack(returned, one)) {
      out.ready.push(one);
      out.returned++;
    } else {
      out.gone++;
    }
  }

  return out;
};

/** Whether any file of a partition is on disk. */
const isBack = async (archives: Archives, partition: CatalogPartition): Promise<boolean> => {
  const mine = idOf(partition);

  for (const { names } of await archives.monthDirsOf(partition))
    for (const name of names) {
      const key = partitionOf(name);

      if (key && idOf(key) === mine) return true;
    }

  return false;
};

/** Why a partition stays on disk, or null where it can go. */
const heldBack = (
  one:       CatalogPartition,
  inCold:    ReadonlyMap<string, string>,
  months:    ReadonlySet<string>,
  lineOf:    (data: string, month: string) => Stocked | undefined,
  settlable: string,
): HeldBack | null => {
  if (inCold.get(idOf(one)) !== one.version) return 'not in cold storage';

  const data = dataOf(one);
  const own  = lineOf(data, one.month);

  if (! own) return 'not stocked';

  /** Whether a neighbouring month has, in the vault, the hours these files hold of it. */
  const given = (version: string | undefined): boolean => !! version && version !== MISSING;

  // Its last hours are in the next month's files — so its own hold the last hours of the month before.
  if (own.postVersion) {
    const before = shift(one.month, -1);

    if (months.has(before) && ! given(lineOf(data, before)?.postVersion)) return 'a neighbouring month still needs it';
  }

  // Its first hours are in the files of the month before — so its own hold the first hours of the month after.
  if (own.preVersion) {
    const after = shift(one.month, 1);

    // Not in the catalog, and it has not had its time yet: not published is not ended.
    if (months.has(after) ? ! given(lineOf(data, after)?.preVersion) : after > settlable) return 'a neighbouring month still needs it';
  }

  return null;
};

/** The newest month that can be settled at this moment, as `YYYYMM`: the one that ended `SETTLE_DAYS` ago or more. */
const settlable = (now: number): string => {
  const at = new Date(now - SETTLE_DAYS * 86_400_000);

  return shift(`${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`, -1);
};

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
const remove = async (
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

/** One venue's answer in a line: what can go. What stays, and why, is counted and not said. */
const said = (found: Evictable): string => [
  found.ready.length > 0 ? loadOf(found.ready) : 'nothing to evict',
  ...(found.returned > 0 ? [`${found.returned.toLocaleString('en-US')} of them evicted before and on disk again`] : []),
  ...(found.gone > 0 ? [`${found.gone.toLocaleString('en-US')} already evicted`] : []),
].join(' · ');

/** What these partitions come to, in the catalog's own counts. */
const loadOf = (ready: Evictable['ready']): string => {
  const files = ready.reduce((sum, one) => sum + one.files, 0);
  const bytes = ready.reduce((sum, one) => sum + one.bytes, 0);

  return `${ready.length.toLocaleString('en-US')} partition${ready.length === 1 ? '' : 's'} evictable `
    + `(${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} · ${fmtBytes(bytes)})`;
};

/** The data a partition holds, whatever the rendering: its venue, market, dataset and variant. */
const dataOf = (key: PartitionKey): string => [key.venue, key.market, key.dataset, key.variant].join('|');

/** A `YYYYMM` shifted by whole months. */
const shift = (month: string, by: number): string => {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1 + by, 1));

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_survey = survey;
export const _test_remove = remove;
