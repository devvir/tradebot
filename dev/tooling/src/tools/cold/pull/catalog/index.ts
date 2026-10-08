import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { POLL_MS, loadConfig } from '../../config';
import { acquire } from '../../lock';
import { agreed } from '../../options';
import { clearStale } from '../../push/catalog';
import { PARTITIONS, SNAPSHOT, TABLES, digestOf, workOf } from '../../push/catalog';
import * as mega from '../../shared/mega';
import * as record from '../../shared/record';
import { applyPartition, applyTables, filesIn } from './apply';
import { fmtBytes } from '../../../../shared/utils/format';
import { info, spacer, success, warn } from '../../../../shared/ui/logger';
import type { ColdConfig } from '../../types';
import type { CatalogCopy, CatalogPull, Fetching, Remote } from '../../shared/types';

/**
 * Bring the catalog's copy back from cold storage, as a database.
 *
 * **Never over the catalog in use.** What comes back is put together in cold's
 * own directory — or where `--output` says — and its path is said: whether and
 * when it takes the place of the one in use is for whoever ran this to decide.
 * A path that is already something is refused.
 *
 * **The snapshot, then what changed since** — see `push/catalog`. The database
 * comes back whole, with its indexes; every table but the files' is replaced by
 * what Mega holds of them, and each partition that has a file of its own has
 * its file rows put into the files' table. See `apply.ts`.
 *
 * **The snapshot is not brought back where it is already here**, whatever is
 * asked. A push can leave it in cold's working directory, and so can a pull.
 * The record holds its digest, what it weighs and Mega's identifier for it, so
 * a file there with that digest — while Mega still holds that very object — is
 * the snapshot, and the hours it would take to bring back are saved.
 *
 * **Anything else found there is said, and removed where that is agreed to**:
 * it is as large as the catalog and of no use.
 *
 * **The disk is left as it was found, unless told otherwise.** A snapshot that
 * was here stays, and what is handed over is a copy of it. One that had to be
 * brought back becomes what is handed over, and none is left. `--keep-snapshot`
 * leaves one either way; `--drop-snapshot` leaves none either way.
 */
export const runPullCatalog = async (options: CatalogPull, remote: Remote & Fetching = mega): Promise<void> => {
  const config = loadConfig('archives');
  const target = targetOf(config, options.output);

  if (fs.existsSync(target)) throw new Error(`${target} is already there — name another place with --output, or move it out of the way`);

  const release = await acquire(config.coldRoot, 'catalog', 'pull');

  try {
    if (! await remote.available?.()) throw new Error('mega-cmd is not available — is the session logged in?');

    const held = await remote.listing(config.catalogRoot);
    const sent = held.get(SNAPSHOT);

    if (! sent) throw new Error(`Cold storage holds no snapshot of the catalog at ${config.catalogRoot}/${SNAPSHOT} — nothing to bring back`);

    if (! held.has(TABLES)) throw new Error(`Cold storage holds no ${config.catalogRoot}/${TABLES} — the snapshot alone is not the catalog. A push writes it`);

    const known = sentSnapshot(config);
    const local = path.join(workOf(config), SNAPSHOT);
    const here  = fs.existsSync(local) && await isSnapshot(local, sent, known);

    // Kept where it was here and nothing says otherwise; handed over itself where it is not to stay.
    const keeps = options.snapshot ? options.snapshot === 'keep' : here;

    // Something else where the snapshot is kept: its place is needed only where one is to be left there.
    if (! here && ! options.dryRun && ! await clearStale(local, null) && keeps)
      throw new Error(`${local} is in the way of the snapshot --keep-snapshot leaves there — remove it, or run this without the flag`);

    const wanted = [...held].filter(([at]) => (at === SNAPSHOT && ! here) || at === TABLES || at.startsWith(`${PARTITIONS}/`));
    const weight = wanted.reduce((sum, [, one]) => sum + one.bytes, 0);
    const deltas = wanted.filter(([at]) => at.startsWith(`${PARTITIONS}/`)).length;

    info(`The catalog's copy: its snapshot (${fmtBytes(sent.bytes)}), its other tables, and ${deltas.toLocaleString('en-US')} partition${deltas === 1 ? '' : 's'} changed since`);
    info(here ? `The snapshot is here already, at ${local} — only what changed since is brought back (${fmtBytes(weight)})`
      : `${fmtBytes(weight)} is brought back`);
    info(`It is put together at ${target}`);

    if (! here && sent.bytes > freeBytes(workOf(config))) warn(`${fmtBytes(freeBytes(workOf(config)))} is free where the snapshot is brought to, and it weighs ${fmtBytes(sent.bytes)}`);
    if (keeps && sent.bytes > freeBytes(path.dirname(target))) warn(`${fmtBytes(freeBytes(path.dirname(target)))} is free at ${path.dirname(target)}, and the catalog weighs ${fmtBytes(sent.bytes)}`);

    spacer();

    if (options.dryRun) return;
    if (! await agreed('Go ahead?', true)) return;

    await fetch(config, new Map(wanted), remote);

    if (! here) {
      // What came back is held to what was sent, where that is known here.
      if (known && known.handle === sent.handle && await digestOf(staged(config, SNAPSHOT)) !== known.version)
        throw new Error(`The snapshot that came back is not the one that was sent: its digest is not the one in the record. It is left at ${staged(config, SNAPSHOT)}`);

    }

    fs.mkdirSync(path.dirname(target), { recursive: true });

    const from = here ? local : staged(config, SNAPSHOT);

    // Not to be kept: it becomes what is handed over. Otherwise it is put where it is kept, and what is handed over is a copy.
    if (! keeps) move(from, target);
    else {
      if (! here) {
        fs.mkdirSync(path.dirname(local), { recursive: true });
        move(from, local);
      }

      await copy(local, target);
    }

    const applied = await apply(target, path.join(staging(config), TABLES), path.join(staging(config), PARTITIONS));

    fs.rmSync(staging(config), { recursive: true, force: true });

    spacer();
    success(`The catalog is at ${target} — ${applied.tables} table${applied.tables === 1 ? '' : 's'} and ${applied.partitions.toLocaleString('en-US')} `
      + `partition${applied.partitions === 1 ? '' : 's'} put into the snapshot. The catalog in use was not touched.`);

    info(keeps ? `The snapshot is kept at ${local}` : 'No snapshot is left on disk');
  } finally {
    release();
  }
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Where the database is left: where it was asked for — a directory, or the file itself — or in cold's own directory. */
const targetOf = (config: ColdConfig, output: string | undefined): string => {
  if (! output) return path.join(config.coldRoot, 'pulled', 'catalog', SNAPSHOT);

  const asked = path.resolve(output);
  const isDir = output.endsWith(path.sep) || path.extname(asked) === '' || (fs.existsSync(asked) && fs.statSync(asked).isDirectory());

  return isDir ? path.join(asked, SNAPSHOT) : asked;
};

/** The snapshot as the record has it sent: its digest and Mega's identifier for it. Null where this record never sent one. */
const sentSnapshot = (config: ColdConfig): CatalogCopy | null => {
  const db = record.open(config.dbPath);

  try {
    const sent = record.catalogCopies(db).get(SNAPSHOT);

    return sent?.state === 'stored' ? sent : null;
  } finally {
    record.close(db);
  }
};

/**
 * Whether a file is the snapshot Mega holds: the object the record sent, at
 * what it weighs and at its digest. Weighed first, since reading all of it for
 * a digest is minutes.
 */
const isSnapshot = async (file: string, held: { bytes: number; handle: string | null }, known: CatalogCopy | null): Promise<boolean> => {
  if (! known || known.handle !== held.handle || known.bytes !== held.bytes || fs.statSync(file).size !== held.bytes) return false;

  info(`Reading ${file}, to hold it to the snapshot that was sent`);

  return await digestOf(file) === known.version;
};

/** Copy a file, saying how far it has got. */
const copy = async (from: string, to: string): Promise<void> => {
  const total = fs.statSync(from).size;

  let copied = 0;
  let said   = 0;

  info(`  copying the snapshot to ${to} (${fmtBytes(total)})`);

  await pipeline(
    fs.createReadStream(from, { highWaterMark: 8 * 1024 ** 2 }),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        copied += chunk.length;

        if (copied - said >= SAY_BYTES) {
          said = copied;

          info(`  copied ${fmtBytes(copied)} of ${fmtBytes(total)}`);
        }

        done(null, chunk);
      },
    }),
    fs.createWriteStream(to),
  );
};

const staging = (config: ColdConfig): string => path.join(config.coldRoot, 'pulling', 'catalog');

const staged = (config: ColdConfig, at: string): string => path.join(staging(config), at);

/**
 * Ask Mega for every file and wait until each is here at the size Mega has it.
 * One already here at that size was brought by a run that stopped, and is not
 * asked for again; one Mega drops is asked for again after a wait.
 */
const fetch = async (
  config: ColdConfig,
  wanted: ReadonlyMap<string, { bytes: number }>,
  remote: Remote & Fetching,
  pollMs = POLL_MS,
): Promise<void> => {
  const here = (at: string): boolean => fs.existsSync(staged(config, at)) && fs.statSync(staged(config, at)).size === wanted.get(at)!.bytes;

  for (let round = 0, said = -1; ; round++) {
    const coming  = await remote.downloadingPaths();
    const missing = [...wanted.keys()].filter(at => ! here(at) || coming.has(staged(config, at)));

    if (missing.length === 0) return;

    // Asked for at first, and again where nothing is bringing it: never while it is still on its way.
    for (const at of missing) {
      if (coming.has(staged(config, at)) || (round > 0 && round % ASK_AGAIN !== 0)) continue;

      fs.mkdirSync(path.dirname(staged(config, at)), { recursive: true });
      fs.rmSync(staged(config, at), { force: true });

      await remote.queueDownload(`${config.catalogRoot}/${at}`, path.dirname(staged(config, at)));
    }

    if (missing.length !== said) info(`  waiting for ${missing.length.toLocaleString('en-US')} file${missing.length === 1 ? '' : 's'} from Mega`);

    said = missing.length;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};

/** Put the tables and the partitions' files into the base. Returns how many of each. */
const apply = async (base: string, tables: string, partitions: string): Promise<{ tables: number; partitions: number }> => {
  const db = new DatabaseSync(base);

  try {
    // Rows go in as they were, whichever table comes first.
    db.exec('PRAGMA foreign_keys = OFF');

    const done = { tables: 0, partitions: 0 };

    done.tables = applyTables(db, tables);

    const changed = filesIn(partitions, '.csv.gz');

    for (const [name, file] of changed) {
      await applyPartition(db, name, file);

      done.partitions++;

      if (done.partitions % SAY_EVERY === 0) info(`  ${done.partitions.toLocaleString('en-US')}/${changed.size.toLocaleString('en-US')} partitions put in`);
    }

    return done;
  } finally {
    db.close();
  }
};

/** Move a file, across volumes where it has to. */
const move = (from: string, to: string): void => {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;

    fs.copyFileSync(from, to);
    fs.rmSync(from);
  }
};

const freeBytes = (dir: string): number => {
  let at = dir;

  while (! fs.existsSync(at)) at = path.dirname(at);

  const stats = fs.statfsSync(at);

  return stats.bavail * stats.bsize;
};

/** How much of the snapshot is copied between one line of progress and the next. */
const SAY_BYTES = 10 * 1024 ** 3;

/** Rounds between asking again for a file nothing is bringing. */
const ASK_AGAIN = 10;

/** Partitions put in between one line of progress and the next. */
const SAY_EVERY = 250;

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_targetOf = targetOf;
export const _test_isSnapshot = isSnapshot;
export const _test_fetch    = fetch;
export const _test_apply    = apply;
