import fs from 'node:fs';
import path from 'node:path';
import inquirer from 'inquirer';
import { binsOf } from './bins';
import * as catalog from './catalog';
import { GB, POLL_MS, WATCH_MS, loadConfig, localPath, remotePath, tarName } from './config';
import { onExit } from './cleanup';
import { Archives, matches } from './disk';
import { idOf, partitionOf } from './keys';
import { acquire } from './lock';
import * as mega from './mega';
import { isWatch } from './options';
import { Progress } from './progress';
import * as record from './record';
import { clearTemporary, membersOf, replaceMembers, tarSize, writePart } from './tar';
import { fmtBytes } from '../../shared/utils/format';
import { error, info, spacer, success, warn } from '../../shared/ui/logger';
import { confirm } from '../../shared/ui/prompts';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition, ColdConfig, Origin, Planned, PushOptions, Round, SourceFile, Tar } from './types';

/**
 * Store what is ready and not in cold storage yet.
 *
 * **What is ready is the catalog's to say**: a partition with nothing left to
 * download that has not changed for a day. Each is checked against the files on
 * disk, packed with the rest of its venue-month into tars of whole partitions,
 * uploaded to Mega, and recorded — which partitions each tar holds, and at
 * which version.
 *
 * **A month gains tars as more of it becomes ready.** Partitions the record
 * does not have yet are planned into new tars; nothing already stored is
 * repacked to make room for them.
 *
 * **A stored partition whose version changed is corrected where it is.** Its tar
 * is brought back from Mega, the old partition taken out and the new one put
 * in, and the tar stored again under the same name. The download runs beside
 * everything else, so the upload link is never idle waiting for it.
 *
 * The shape of the run is dictated by the link: uploading is hours per tar
 * while packing one is minutes. So this does **not** pack everything and then
 * upload it — that would fill the disk with tars waiting on a week of
 * bandwidth. It keeps just enough packed to keep the queue fed.
 *
 * Every step is resumable, because a run that takes a week will be interrupted.
 * A tar's state is written as it moves, a tar is proved before it is uploaded,
 * and an upload is confirmed from Mega rather than from an exit code.
 */
export const runPush = async (origin: Origin, options: PushOptions): Promise<void> => {
  const config  = loadConfig(origin);
  const release = await acquire(config.coldRoot, origin, 'push');

  try {
    if (! await mega.available()) {
      error('mega-cmd is not available — is the session logged in?');

      return;
    }

    const lens = await lensFor(config, options.lens);

    if (lens === undefined) return;

    const db = record.open(config.dbPath);

    // Also on the signal path: `process.exit` in a handler skips every pending
    // `finally`, so a Ctrl-C would otherwise leave the record open.
    onExit(() => record.close(db));

    try {
      const swept = await clearTemporary(path.join(config.coldRoot, origin));

      if (swept > 0) info(`Cleared ${swept} unfinished tar${swept === 1 ? '' : 's'} from a previous run`);

      const venues = options.venues.length > 0 ? options.venues : await catalog.venues(config);

      info(`Asking the catalog what is ready to push${lens ? `, through ${lens}` : ''}`);

      const planned = await plan(db, config, origin, venues, lens);
      const todo    = outstanding(db, origin, venues);

      if (todo.length === 0 && ! isWatch()) {
        success(`Everything that is ready from ${venues.join(', ')} is in cold storage — nothing to push`);

        return;
      }

      if (todo.length > 0 && ! await approve(db, todo, planned)) return;

      await work(db, config, origin, venues, lens, isWatch());
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Which lens to read the catalog through: none unless one was asked for, the
 * one named, or the one picked from the catalog's list. `undefined` where the
 * answer is that the run should not go on.
 */
const lensFor = async (config: ColdConfig, asked: string | true | undefined): Promise<string | null | undefined> => {
  if (asked === undefined) return null;

  const known = await catalog.lenses(config);

  if (asked !== true) {
    if (known.some(one => one.slug === asked)) return asked;

    error(`No lens called "${asked}". Known: ${known.map(one => one.slug).join(', ') || '(none)'}`);

    return undefined;
  }

  if (known.length === 0) {
    error('The catalog has no lenses to choose from');

    return undefined;
  }

  const { slug } = await inquirer.prompt<{ slug: string }>([{
    type: 'list', name: 'slug', message: 'Through which lens?',
    choices: known.map(one => ({ value: one.slug, name: `${one.slug} — ${one.note || one.name}` })),
  }]);

  return slug;
};

/**
 * Set what the catalog says is ready against what the record holds, venue by
 * venue, and write down what follows from the difference.
 *
 * - **A partition the record does not have** is planned into a new tar of its
 *   venue-month.
 * - **One it has at another version** is noted as changed, and its tar — where
 *   Mega already holds it — becomes one to bring back and correct.
 * - **One it has at this version** needs nothing.
 *
 * A partition the catalog does not answer with is left exactly as it is: it is
 * outside the lens, still downloading, or still changing, and none of those is
 * a reason to touch what is stored.
 */
const plan = async (
  db:     DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  venues: readonly string[],
  lens:   string | null,
  say:    (line: string) => void = info,
): Promise<Planned> => {
  const settledBefore = config.settledHours === null
    ? null
    : new Date(Date.now() - config.settledHours * 3_600_000).toISOString();
  const total: Planned = { tars: 0, added: 0, changed: 0, stale: 0 };

  for (const venue of venues) {
    const ready = await catalog.readyPartitions(config, venue, settledBefore, lens);

    // Asked first, dropped second: a catalog that does not answer leaves the plan as it was.
    record.dropPlanned(db, origin, venue);

    const held  = new Map(record.heldOf(db, origin, venue).map(one => [idOf(one), one]));
    const fresh = new Map<string, CatalogPartition[]>();

    let changed = 0;

    for (const one of ready) {
      const had = held.get(idOf(one));

      if (! had) {
        fresh.set(one.month, [...fresh.get(one.month) ?? [], one]);

        continue;
      }

      if (had.version === one.version || had.next?.version === one.version) continue;

      record.noteChange(db, had, one);
      changed++;
    }

    let tars = 0;

    for (const [month, partitions] of [...fresh].sort())
      for (const bin of binsOf(partitions, config.capBytes)) {
        record.planTar(db, origin, venue, month, seq => ({
          remote: `${venue}/${month.slice(0, 4)}/${tarName(venue, month, seq)}`,
          local:  `${venue}/${tarName(venue, month, seq)}`,
        }), bin.partitions);

        tars++;
      }

    const added = [...fresh.values()].reduce((sum, list) => sum + list.length, 0);

    say(`  ${venue.padEnd(8)} ${loadOf(db, toPush(outstanding(db, origin, [venue])))}`
      + (changed > 0 ? ` · ${changed} stored partition${changed === 1 ? '' : 's'} changed` : ''));

    total.tars    += tars;
    total.added   += added;
    total.changed += changed;
  }

  total.stale = record.tarsOf(db, origin).filter(tar => tar.state === 'stale').length;

  return total;
};

/** The tars of these venues that are not in cold storage as the record wants them. */
const outstanding = (db: DatabaseSync, origin: Origin, venues: readonly string[]): Tar[] =>
  record.tarsOf(db, origin).filter(tar => tar.state !== 'stored' && venues.includes(tar.venue));

/** The tars that hold partitions not in cold storage yet, as opposed to stored ones being corrected. */
const toPush = (tars: readonly Tar[]): Tar[] =>
  tars.filter(tar => ! ['stale', 'fetching', 'fetched'].includes(tar.state));

/** What these tars amount to, in a line. */
const loadOf = (db: DatabaseSync, tars: readonly Tar[]): string => {
  const held = tars.flatMap(tar => record.heldIn(db, tar.id));

  if (held.length === 0) return 'nothing new';

  const files = held.reduce((sum, one) => sum + one.files, 0);
  const bytes = held.reduce((sum, one) => sum + one.bytes, 0);

  return `${held.length.toLocaleString('en-US')} new partition${held.length === 1 ? '' : 's'} ready to push `
    + `(${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} · `
    + `${tars.length} tar${tars.length === 1 ? '' : 's'} · ${fmtBytes(bytes)})`;
};

const approve = async (db: DatabaseSync, todo: Tar[], planned: Planned): Promise<boolean> => {
  const back = todo.length - toPush(todo).length;

  spacer();
  info(loadOf(db, toPush(todo)));

  if (back > 0)
    info(`${back} stored tar${back === 1 ? '' : 's'} to bring back and correct — `
      + `${planned.changed > 0 ? `${planned.changed} partitions changed since they were stored` : 'left from an earlier run'}`);

  spacer();

  return confirm('Go ahead?', true);
};

/**
 * Move every outstanding tar as far as it will go, one step at a time, until
 * each is stored or cannot move.
 *
 * **One pass over the tars is one round**, and each tar takes the step its
 * state calls for: a planned one is packed, a packed one handed to Mega, a
 * queued one confirmed, a stale one asked for, a fetched one corrected. Packing
 * is the only step that waits — on the upload queue having room — and while it
 * waits the other tars keep moving, which is what lets a tar come back from
 * Mega while others are being sent.
 */
const work = async (
  db:     DatabaseSync,
  config: ColdConfig,
  origin: Origin,
  venues: readonly string[],
  lens:   string | null,
  watch:  boolean,
): Promise<void> => {
  const archives = new Archives(config.sourceRoot);
  const failed   = new Set<number>();
  const all      = record.tarsOf(db, origin).filter(tar => venues.includes(tar.venue));
  const progress = new Progress(all.length, all.filter(tar => tar.state === 'stored').length);

  onExit(() => progress.stop());
  progress.start();

  /** When the catalog is asked again, in watch mode; and whether the wait has been announced. */
  let scanAt  = Date.now() + WATCH_MS;
  let waiting = false;

  for (;;) {
    let todo = outstanding(db, origin, venues).filter(tar => ! failed.has(tar.id));

    if (watch && Date.now() >= scanAt) {
      await scan(db, config, origin, venues, lens, progress, todo.length > 0);

      // What would not move an hour ago may move now: a scan is a new run for it.
      failed.clear();

      scanAt = Date.now() + WATCH_MS;
      todo   = outstanding(db, origin, venues);

      if (todo.length > 0) waiting = false;
    }

    if (todo.length === 0) {
      if (! watch) break;

      if (! waiting) progress.log('Watch mode - Waiting for new partitions to push');

      waiting = true;

      await sleep(Math.max(1_000, Math.min(POLL_MS, scanAt - Date.now())));

      continue;
    }

    let moved = false;

    const round = roundOf(config);

    for (const tar of todo) {
      try {
        if (await step(db, config, origin, archives, tar, progress, round)) moved = true;
      } catch (err) {
        /**
         * **One tar failing does not end the run.** This is left going against
         * days of uploading while the tree it reads is still being written to.
         * The tar keeps its state and its turn comes round on the next run.
         */
        progress.log(`${labelOf(tar)}: ${(err as Error).message}`);
        failed.add(tar.id);
      }
    }

    // Nothing moved: everything left is waiting on Mega, so ask again in a while.
    if (! moved) await sleep(POLL_MS);
  }

  progress.stop();

  const done = record.totals(db, origin);

  spacer();

  if (failed.size > 0)
    warn(`${failed.size} tar${failed.size === 1 ? '' : 's'} could not be moved on — each keeps its place `
      + 'and is tried again on the next run');

  info(`${done.stored}/${done.tars} tars in cold storage · ${fmtBytes(done.storedBytes)} · `
    + `${done.partitions} partitions recorded`);

  if (failed.size === 0) success('Pushed all partitions that were ready. Bye!');
};

/**
 * Ask the catalog again, in the middle of a run, and plan what it now has
 * ready.
 *
 * **Said in full when there was nothing to do, and in a line when there was.**
 * A run that is waiting has nothing else to show, so the asking and each
 * venue's answer are what it shows. A run that is packing and uploading is
 * already saying what it is doing, so the asking goes unremarked unless it
 * found something — which is then one line, and joins the queue.
 *
 * A catalog that does not answer costs this scan and nothing else: the plan is
 * left as it was and the next scan asks again.
 */
const scan = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  venues:   readonly string[],
  lens:     string | null,
  progress: Progress,
  busy:     boolean,
): Promise<void> => {
  // By partition and not by tar: a plan is redrawn, and a tar of the same name may hold more than it did.
  const waitingFor = (): string[] =>
    toPush(outstanding(db, origin, venues)).flatMap(tar => record.heldIn(db, tar.id).map(idOf));

  const before = new Set(waitingFor());
  const say    = busy ? (): void => {} : (line: string): void => progress.log(line);

  say(`Asking the catalog what is ready to push${lens ? `, through ${lens}` : ''}`);

  try {
    const planned = await plan(db, config, origin, venues, lens, say);
    const fresh   = waitingFor().filter(id => ! before.has(id)).length;

    if (busy && fresh > 0)
      progress.log(`Found ${fresh.toLocaleString('en-US')} new partition${fresh === 1 ? '' : 's'} ready to push`);

    if (planned.changed > 0)
      progress.log(`${planned.changed} stored partition${planned.changed === 1 ? '' : 's'} changed — `
        + 'their tars will be brought back and corrected');
  } catch (err) {
    progress.log(`Could not ask the catalog: ${(err as Error).message}`);
  }

  const all = record.tarsOf(db, origin).filter(tar => venues.includes(tar.venue));

  progress.resize(all.length, all.filter(tar => tar.state === 'stored').length);
};

/**
 * Take one tar one step. Says whether anything moved, so a round in which
 * nothing did is one to wait after.
 */
const step = async (
  db:       DatabaseSync,
  config:   ColdConfig,
  origin:   Origin,
  archives: Archives,
  tar:      Tar,
  progress: Progress,
  round:    Round,
): Promise<boolean> => {
  const local = localPath(config, origin, tar);

  switch (tar.state) {
    case 'planned': {
      // Packing ahead of the link only fills the disk with tars waiting to go.
      if (! await round.room()) return false;

      const held    = record.heldIn(db, tar.id);
      const members: string[] = [];
      const sized:   SourceFile[] = [];

      // Shown before the files are gathered: on a tar of small files that is minutes.
      progress.working('Checking', labelOf(tar));

      for (const one of held) {
        const files = await archives.filesOf(one);

        if (! matches(files, one)) {
          progress.worked();

          throw new Error(`${idOf(one)} is not on disk as the catalog says `
            + `(${files.length} files there, ${one.files} expected) — left for the next run`);
        }

        // Not spread: a partition can hold more files than a call takes arguments.
        for (const file of files) {
          members.push(file.path);
          sized.push(file);
        }
      }

      // Against what the tar will weigh, not what it holds: a header and padding
      // per member is most of a tar of small files, and the bar would stand at
      // 100% through most of the writing.
      progress.working('Packing', labelOf(tar), `${local}.tmp`, tarSize(sized));

      try {
        await writePart(config.sourceRoot, local, members, () => progress.verifying());
      } catch (err) {
        progress.worked();

        throw err;
      }

      const bytes = fs.statSync(local).size;

      record.packed(db, tar.id, bytes);
      progress.worked(`Packed ${labelOf(tar)} · ${fmtBytes(bytes)}`);

      // One tar a round: the queue is asked again before another is made.
      round.packed();

      return true;
    }

    case 'packed': {
      /**
       * A packed tar that is not on disk was lost between runs. What that means
       * depends on whether Mega has an older one: a tar being corrected goes
       * back to being fetched, and a new one back to being packed.
       */
      if (! fs.existsSync(local)) {
        record.move(db, tar.id, tar.handle ? 'stale' : 'planned');

        return true;
      }

      if (! (await round.uploads()).has(local))
        await mega.queueUpload(local, path.dirname(remotePath(config, tar)));

      record.move(db, tar.id, 'queued');

      return true;
    }

    case 'queued': {
      const found = await mega.remote(remotePath(config, tar));

      /**
       * **Confirmed from Mega, never from an exit code.** Mega publishes a file
       * only once it is complete, so the right size at the path is the proof —
       * and where a tar replaces an older one, a handle that is no longer the
       * older one's, since the two can weigh the same.
       */
      if (found && found.bytes === tar.bytes && (tar.handle === null || found.handle !== tar.handle)) {
        record.applyChanges(db, tar.id);
        record.stored(db, tar.id, found.handle);

        await fs.promises.rm(local, { force: true });

        progress.stored(labelOf(tar), tar.bytes ?? 0);

        return true;
      }

      // Mega dropped it from its queue without storing it: hand it over again.
      if (! (await round.uploads()).has(local)) {
        record.move(db, tar.id, 'packed');

        return true;
      }

      return false;
    }

    case 'stale': {
      await fs.promises.mkdir(path.dirname(local), { recursive: true });
      await fs.promises.rm(local, { force: true });
      await mega.queueDownload(remotePath(config, tar), path.dirname(local));

      record.move(db, tar.id, 'fetching');

      progress.log(`Bringing ${labelOf(tar)} back to correct it · ${fmtBytes(tar.bytes ?? 0)}`);

      return true;
    }

    case 'fetching': {
      const here = fs.existsSync(local) ? fs.statSync(local).size : -1;

      if (here === tar.bytes && ! (await round.downloads()).has(local)) {
        record.move(db, tar.id, 'fetched');

        return true;
      }

      // Mega dropped it from its queue without finishing: ask for it again.
      if (! (await round.downloads()).has(local)) {
        record.move(db, tar.id, 'stale');

        return true;
      }

      return false;
    }

    case 'fetched': {
      const changed = record.heldIn(db, tar.id).filter(one => one.next !== null);
      const stale   = new Set(changed.map(idOf));
      const add: string[] = [];

      for (const one of changed) {
        const files = await archives.filesOf(one);

        if (! matches(files, one.next!))
          throw new Error(`${idOf(one)} is not on disk as the catalog says — left for the next run`);

        add.push(...files.map(file => file.path));
      }

      const remove = (await membersOf(local)).filter(member => {
        const key = partitionOf(member);

        return key !== null && stale.has(idOf(key));
      });

      progress.working('Correcting', labelOf(tar));

      try {
        await replaceMembers(config.sourceRoot, local, remove, add);
      } catch (err) {
        progress.worked();

        throw err;
      }

      record.packed(db, tar.id, fs.statSync(local).size);
      progress.worked(`Corrected ${labelOf(tar)} · ${changed.length} partition${changed.length === 1 ? '' : 's'} · `
        + `${remove.length} files out, ${add.length} in`);

      return true;
    }

    default:
      return false;
  }
};

/**
 * What Mega says for the length of one round, asked once however many tars
 * want to know: whether the upload queue has room for another tar, and which
 * local paths it is sending and bringing back.
 */
const roundOf = (config: ColdConfig): Round => {
  let room:      Promise<boolean> | null = null;
  let uploads:   Promise<Set<string>> | null = null;
  let downloads: Promise<Set<string>> | null = null;

  return {
    room:      () => (room ??= mega.queue().then(queue => queue.remaining <= config.queueTargetGb * GB)),
    packed:    () => { room = Promise.resolve(false); },
    uploads:   () => (uploads ??= mega.queuedPaths()),
    downloads: () => (downloads ??= mega.downloadingPaths()),
  };
};

const labelOf = (tar: Tar): string => `${tar.venue}/${path.basename(tar.local)}`;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_plan = plan;
export const _test_scan = scan;
