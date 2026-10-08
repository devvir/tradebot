import { GB, POLL_MS, WATCH_MS } from '../../config';
import { recordOf, save } from '../../shared/backup';
import { onExit } from '../../cleanup';
import { Archives } from '../../shared/disk';
import { idOf } from '../../shared/keys';
import * as mega from '../../shared/mega';
import { Progress } from '../../shared/progress';
import * as record from '../../shared/record';
import { fmtBytes } from '../../../../shared/utils/format';
import { info, spacer, success, warn } from '../../../../shared/ui/logger';
import { outstanding, plan, toPush } from './plan';
import { labelOf, step } from './step';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin } from '../../types';
import type { Round } from '../types';

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
export const work = async (
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

      // Everything found has been sent: what that changed is kept too, before the wait.
      if (! waiting) await save(config, [recordOf(config)]);

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

// ── Internals ─────────────────────────────────────────────────────────────────

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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_scan = scan;
