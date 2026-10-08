import path from 'node:path';
import inquirer from 'inquirer';
import * as catalog from '../../shared/catalog';
import { loadConfig } from '../../config';
import { onExit } from '../../cleanup';
import { acquire } from '../../lock';
import * as mega from '../../shared/mega';
import { agreed, isWatch } from '../../options';
import { runPushVault } from '../vault';
import * as record from '../../shared/record';
import { clearTemporary } from './pack';
import { error, info, spacer, success } from '../../../../shared/ui/logger';
import { loadOf, outstanding, plan, toPush } from './plan';
import { work } from './work';
import type { DatabaseSync } from 'node:sqlite';
import type { ColdConfig, Origin, Tar } from '../../types';
import type { Planned, PushOptions } from '../types';

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
  // The vault is stored as it is, file by file, and has a run of its own.
  if (origin === 'vault') return runPushVault(options);

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

const approve = async (db: DatabaseSync, todo: Tar[], planned: Planned): Promise<boolean> => {
  const back = todo.length - toPush(todo).length;

  spacer();
  info(loadOf(db, toPush(todo)));

  if (back > 0)
    info(`${back} stored tar${back === 1 ? '' : 's'} to bring back and correct — `
      + `${planned.changed > 0 ? `${planned.changed} partitions changed since they were stored` : 'left from an earlier run'}`);

  spacer();

  return agreed('Go ahead?', true);
};
