import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { onExit } from '../../cleanup';
import { POLL_MS, loadConfig } from '../../config';
import { acquire } from '../../lock';
import { agreed } from '../../options';
import * as mega from '../../shared/mega';
import * as record from '../../shared/record';
import { fileSchemaOf, openCatalog, partitionsOf, writePartition, writeTables } from './source';
import { fmtBytes } from '../../../../shared/utils/format';
import { info, spacer, success, warn } from '../../../../shared/ui/logger';
import type { CatalogCopy, Remote } from '../../shared/types';
import type { ColdConfig } from '../../types';
import type { CatalogOptions, CatalogPartitionRow, Sending } from '../types';

/**
 * Keep a copy of the catalog in cold storage: the database itself, and beside
 * it whatever has changed since.
 *
 * **The catalog can be rebuilt from the venues, given days — and not at all
 * where a venue has since withdrawn what it published.** So it is copied: not
 * to be pulled and used the next minute, but so that losing it costs a restore
 * and not a survey.
 *
 * **The snapshot is `catalog.db` as it was sent, whole.** Every table and every
 * index, with nothing left to get wrong. It is copied into cold's own working
 * directory and the copy is what is sent: sending takes hours, and the catalog
 * is free again the moment the copy is taken. The record keeps its digest and
 * what it weighs, and Mega's own identifier for it once it is stored, so a
 * snapshot found on disk later can be told from any other file.
 *
 * **After that, a push sends what changed.** A partition whose version in the
 * catalog is no longer the one written down has its file rows written to a
 * file of its own — see `source.ts` — which replaces the one sent before for
 * that partition, however often it changes. Everything but the file rows is
 * sent every time, as one small database — see `writeTables`.
 *
 * **`--rebase` takes a new snapshot**: the database is sent again, the versions
 * written down again, and the partitions' files sent since the one before are
 * removed. Worth doing now and then — and needed once the catalog declares its
 * table of files otherwise than the snapshot has it: what is sent after a
 * snapshot is put into that table, so a push that finds it changed says so and
 * asks whether to take a new snapshot or stop.
 *
 * **Not while the catalog is being written.** What is read is read at one
 * moment, so this waits for prospector to be stopped, and makes the database
 * one file — see `whole`. **It says when the catalog is free again**: as soon
 * as everything is read out of it, long before Mega has it all.
 *
 * **The snapshot on disk is cold's own.** A run that takes one removes it once
 * Mega has it, unless `--keep-snapshot` — where a pull then finds it and brings
 * nothing so large back. A run that takes none leaves alone whatever is there,
 * unless `--drop-snapshot`. Whether one is there is read off the disk each
 * time, and written down nowhere: it is anyone's to delete.
 */
export const runPushCatalog = async (options: CatalogOptions, remote: Remote = mega): Promise<void> => {
  const config = loadConfig('archives');

  if (! fs.existsSync(config.catalogDb)) throw new Error(`No catalog at ${config.catalogDb} — is CATALOG_DIR right?`);

  const release = await acquire(config.coldRoot, 'catalog', 'push');

  try {
    const db = record.open(config.dbPath);

    onExit(() => record.close(db));

    try {
      const staging = workOf(config);
      const sent    = record.catalogCopies(db).get(SNAPSHOT);

      let rebase = options.rebase ?? false;
      let taking = rebase || sent?.state !== 'stored';

      // A snapshot copied by a run that stopped before Mega had it: what is left is to send it, and the catalog is not read again.
      const resumed = ! rebase && sent?.state === 'queued' && fs.existsSync(path.join(staging, VERSIONS))
        && fs.existsSync(path.join(staging, SNAPSHOT)) && fs.statSync(path.join(staging, SNAPSHOT)).size === sent.bytes;

      if (resumed) info(`The snapshot was copied by a run before this one (${fmtBytes(sent.bytes)}) — what is left is to send it`);

      if (options.dryRun && resumed) return;

      if (! taking && ! options.dryRun) await clearStale(path.join(staging, SNAPSHOT), sent!.bytes);
      if (! options.dryRun && ! await remote.available?.()) throw new Error('mega-cmd is not available — is the session logged in?');

      let tables = 0;
      let files  = { partitions: 0, bytes: 0 };

      if (! resumed) {
        await stopped();

        if (! options.dryRun) await whole(config.catalogDb);

        const catalog = openCatalog(config.catalogDb);

        try {
          const partitions = partitionsOf(catalog);
          const copies     = record.catalogCopies(db);

          /**
           * What is sent after a snapshot goes into its table of files, so the
           * table has to be declared as it was — see `fileSchemaOf`. Where it
           * is not, this push cannot add to the snapshot Mega holds.
           */
          if (! taking && sent!.schema !== null && sent!.schema !== fileSchemaOf(catalog)) {
            warn('The catalog\'s table of files is no longer declared as the snapshot in Mega has it — what changed since cannot be put into that snapshot');

            if (options.dryRun) return;
            if (! await agreed(`Take a new snapshot instead (--rebase, ${fmtBytes(fs.statSync(config.catalogDb).size)})? Nothing is sent otherwise`, false)) return;

            rebase = true;
            taking = true;
          }
          const changed    = taking ? [] : partitions.filter(one => copies.get(one.name)?.version !== one.version || copies.get(one.name)?.state !== 'stored');

          if (taking) info(`${rebase && sent ? 'A new snapshot' : 'A snapshot'} of the catalog is taken: ${fmtBytes(fs.statSync(config.catalogDb).size)}`);
          else info(`${count(partitions.length, 'partition')} in the catalog · ${count(changed.length, 'partition')} changed since ${changed.length === 1 ? 'it was' : 'they were'} last sent`);

          info('Every table but the files\' is sent with it');
          spacer();

          if (options.dryRun) return;
          if (! await agreed('Go ahead?', true)) return;

          const state: Sending = { db, config, catalog, remote, staging, writing };

          // Everything that is read out of the catalog is read here, and the catalog is free from then on.
          if (taking) await copySnapshot(state, partitions);

          tables = writeTables(catalog, path.join(staging, TABLES)).tables;
          files  = await writePartitions(state, changed);
        } finally {
          catalog.close();
        }

        spacer();
        success('The catalog is free again: what is sent is read out of it. Prospector and the catalog service can be started.');
        spacer();
      }

      if (taking) await storeSnapshot(db, config, staging, remote, rebase);

      await deliver(db, config, staging, remote);

      spacer();
      success(`The catalog's copy is current: ${taking ? 'the snapshot, ' : ''}${count(tables, 'table')} and ${count(files.partitions, 'partition')} sent`
        + (files.bytes > 0 ? ` (${fmtBytes(files.bytes)})` : ''));

      settleSnapshot(path.join(staging, SNAPSHOT), taking, options.snapshot);
    } finally {
      record.close(db);
    }
  } finally {
    release();
  }
};

/** Cold's own working directory for the catalog: where its snapshot is, and what is on its way to Mega. */
export const workOf = (config: ColdConfig): string => path.join(config.coldRoot, 'catalog');

/**
 * What becomes of the snapshot on disk as a push ends.
 *
 * - **A run that took one** removes it now that Mega has it, unless told to
 *   keep it.
 * - **A run that took none** leaves whatever is there, and removes it where
 *   told to drop it. Told to keep it, it has nothing to keep or not: said, with
 *   whether one is there, since whoever asked may think otherwise.
 */
export const settleSnapshot = (file: string, taking: boolean, asked: 'keep' | 'drop' | undefined): void => {
  const there = fs.existsSync(file);

  if (! taking && asked === 'keep')
    return warn(`--keep-snapshot does nothing here: this run took no snapshot. ${there ? `One is on disk, at ${file}, and stays` : 'None is on disk'}`);

  if (! there || (taking ? asked === 'keep' : asked !== 'drop')) {
    if (there && taking) info(`The snapshot is kept at ${file}`);

    return;
  }

  fs.rmSync(file, { force: true });

  info('The snapshot is removed from disk');
};

/**
 * A file where the snapshot is kept that is not the snapshot Mega holds: said,
 * and removed where that is agreed to. It is of no use to a pull and is as
 * large as the catalog. `bytes` is what the snapshot weighs.
 *
 * Told by its weight alone here — a pull, which reads it, holds it to its
 * digest. Returns whether it is gone.
 */
export const clearStale = async (file: string, bytes: number | null): Promise<boolean> => {
  if (! fs.existsSync(file) || fs.statSync(file).size === bytes) return true;

  warn(`${file} is not the snapshot cold storage holds (${fmtBytes(fs.statSync(file).size)}) — it is of no use here`);

  if (! await agreed('Delete it?', true)) return false;

  fs.rmSync(file, { force: true });

  return true;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Copy the database into cold's working directory, and hold the copy to what
 * was read: its digest, taken as it was read, and what it weighs.
 *
 * **It is the copy that is sent, never the database.** The copy is of one
 * moment — nothing is writing while it is taken — and the version of every
 * partition is written down beside it, of that same moment.
 */
const copySnapshot = async ({ db, config, catalog, staging }: Sending, partitions: readonly CatalogPartitionRow[]): Promise<void> => {
  const schema = fileSchemaOf(catalog);
  const to    = path.join(staging, SNAPSHOT);
  const total = fs.statSync(config.catalogDb).size;
  const hash  = createHash('sha256');

  fs.mkdirSync(staging, { recursive: true });
  fs.rmSync(path.join(staging, VERSIONS), { force: true });

  let copied = 0;
  let said   = 0;

  info(`  copying the catalog (${fmtBytes(total)})`);

  await pipeline(
    fs.createReadStream(config.catalogDb, { highWaterMark: 8 * 1024 ** 2 }),
    new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);

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

  if (fs.statSync(to).size !== total || fs.statSync(config.catalogDb).size !== total)
    throw new Error('The copy of the catalog is not the size the catalog is — it is not a snapshot of it, and nothing is sent');

  fs.writeFileSync(path.join(staging, VERSIONS), JSON.stringify(Object.fromEntries(partitions.map(one => [one.name, one.version]))));

  record.queueCatalogCopy(db, { name: SNAPSHOT, kind: 'base', remote: SNAPSHOT, version: hash.digest('hex'), bytes: copied, schema });
};

/**
 * Send the snapshot and wait until Mega holds it; then write down Mega's
 * identifier for it and the version of every partition as it has them. Nothing
 * is written down until it is there.
 *
 * **Read once more before it goes**: its digest has to be the one taken as the
 * catalog was read. A copy that is not what was read is not sent.
 */
const storeSnapshot = async (db: DatabaseSync, config: ColdConfig, staging: string, remote: Remote, rebase: boolean, pollMs = POLL_MS): Promise<void> => {
  const local = path.join(staging, SNAPSHOT);
  const known = record.catalogCopies(db).get(SNAPSHOT)!;
  const bytes = fs.statSync(local).size;

  info('  reading the snapshot back, to hold it to what was read from the catalog');

  if (await digestOf(local) !== known.version) {
    record.dropCatalogCopy(db, SNAPSHOT);

    throw new Error(`The snapshot at ${local} is not what was read from the catalog — it is not sent. Run this again to take another`);
  }

  for (let waited = 0, asked = false; ; waited += pollMs) {
    const there  = (await remote.listing(config.catalogRoot)).get(SNAPSHOT);
    const queued = (await remote.queuedPaths()).has(local);

    if (there && there.bytes === bytes && ! queued && asked) {
      record.storeCatalogCopy(db, SNAPSHOT, there.handle);

      break;
    }

    // Handed over once, and again only where Mega has dropped it: never while it is on its way.
    if (! queued && (! asked || waited % ASK_MS === 0)) {
      await remote.queueUpload(local, config.catalogRoot);

      asked = true;
    }

    if (waited % SAY_MS === 0) info(waited === 0 ? `  sending the snapshot (${fmtBytes(bytes)})` : `  still sending the snapshot (${Math.round(waited / 60_000)} min)`);

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  const versions = JSON.parse(fs.readFileSync(path.join(staging, VERSIONS), 'utf8')) as Record<string, string>;

  record.coverCatalog(db, Object.entries(versions).map(([name, version]) => ({ name, kind: 'partition' as const, version })));

  fs.rmSync(path.join(staging, VERSIONS), { force: true });

  // What was sent of partitions since the snapshot before this one is in this one.
  if (rebase) await remote.removeTree?.(`${config.catalogRoot}/${PARTITIONS}`);
};

/** A file's SHA-256, in hex. */
export const digestOf = async (file: string): Promise<string> => {
  const hash = createHash('sha256');

  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 ** 2 })) hash.update(chunk as Buffer);

  return hash.digest('hex');
};

/** Write each changed partition's file rows to its file, and write down that it is on its way. Returns how much that was. */
const writePartitions = async ({ db, catalog, staging }: Sending, partitions: readonly CatalogPartitionRow[]): Promise<{ partitions: number; bytes: number }> => {
  const done = { partitions: 0, bytes: 0 };

  for (const [at, one] of partitions.entries()) {
    const file  = `${PARTITIONS}/${one.venue}/${one.month.slice(0, 4)}/${one.name}.csv.gz`;
    const wrote = await writePartition(catalog, one.id, path.join(staging, file));

    record.queueCatalogCopy(db, { name: one.name, kind: 'partition', remote: file, version: one.version, bytes: wrote.bytes });

    done.partitions++;
    done.bytes += wrote.bytes;

    if ((at + 1) % SAY_EVERY === 0 || at + 1 === partitions.length)
      info(`  written ${(at + 1).toLocaleString('en-US')}/${partitions.length.toLocaleString('en-US')} partitions · ${fmtBytes(done.bytes)}`);
  }

  return done;
};

/**
 * Hand to Mega every file waiting in the working directory — the tables'
 * database, and the partitions written down as on their way — and wait until it has them.
 * Each leaves the directory as Mega confirms it.
 */
const deliver = async (db: DatabaseSync, config: ColdConfig, staging: string, remote: Remote, pollMs = POLL_MS): Promise<void> => {
  const tables  = [path.join(staging, TABLES)].filter(file => fs.existsSync(file));
  const pending = (): CatalogCopy[] => [...record.catalogCopies(db).values()].filter(one => one.kind === 'partition' && one.state !== 'stored');

  if (tables.length > 0) await remote.queueUploads!(tables, config.catalogRoot);

  const dirs = new Map<string, string[]>();

  for (const one of pending()) {
    if (! fs.existsSync(path.join(staging, one.remote))) continue;

    dirs.set(path.posix.dirname(one.remote), [...dirs.get(path.posix.dirname(one.remote)) ?? [], path.join(staging, one.remote)]);
  }

  for (const [dir, files] of dirs) await remote.queueUploads!(files, `${config.catalogRoot}/${dir}`);

  // Until Mega has every one of them. Only after a wait is one that is in neither place taken for dropped.
  for (let round = 0, said = -1; ; round++) {
    const queued = await remote.queuedPaths();
    const held   = pending().length > 0 ? await remote.listing(`${config.catalogRoot}/${PARTITIONS}`) : new Map<string, { bytes: number; handle: string | null }>();

    let left = tables.filter(file => queued.has(file)).length;

    for (const one of pending()) {
      const there = held.get(one.remote.slice(PARTITIONS.length + 1));
      const local = path.join(staging, one.remote);

      if (there && there.bytes === one.bytes && ! queued.has(local)) {
        record.storeCatalogCopy(db, one.name, there.handle);

        fs.rmSync(local, { force: true });

        continue;
      }

      left++;

      if (round > 0 && ! queued.has(local) && fs.existsSync(local)) await remote.queueUpload(local, `${config.catalogRoot}/${path.posix.dirname(one.remote)}`);
    }

    if (left === 0) break;

    if (left !== said) info(`  waiting for Mega to take ${left.toLocaleString('en-US')} file${left === 1 ? '' : 's'}`);

    said = left;

    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  for (const file of tables) fs.rmSync(file, { force: true });
};

/**
 * Wait until nothing has the catalog open, saying once what to do about it.
 * Whoever ran this stops them, or gives up.
 *
 * Prospector, since it writes it; and the catalog's own service, since a
 * database somebody is reading cannot be made one file.
 */
const stopped = async (): Promise<void> => {
  for (let said = false; ; said = true) {
    const up = [];

    for (const one of [WRITER, READER]) if (await running(one)) up.push(one);

    if (up.length === 0) return;

    if (! said) warn(`${up.join(' and ')} ${up.length === 1 ? 'is' : 'are'} running — stop ${up.length === 1 ? 'it' : 'them'} with \`tb down archives\`. Waiting until ${up.length === 1 ? 'it is' : 'they are'} gone (Ctrl-C to give up)`);

    await new Promise(resolve => setTimeout(resolve, WRITER_MS));
  }
};

/**
 * Make the database one file: fold what is in its write-ahead log into it.
 *
 * **A log beside the database is the sign of a connection that did not close
 * last**, and `catalog.db` alone is then not all of the catalog. Opening it and
 * closing it — as the only one there — folds the log in and removes it. So that
 * is done, and after a moment the log is looked for again: one that is back, or
 * never went, is somebody else's with the database open, and nothing is copied
 * while that is so.
 */
const whole = async (file: string): Promise<void> => {
  const beside = (): string[] => ['-wal', '-shm'].map(end => `${file}${end}`).filter(one => fs.existsSync(one));

  if (beside().length === 0) return;

  info('Folding the catalog\'s write-ahead log into it');

  const db = new DatabaseSync(file);

  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  if (beside().length > 0)
    throw new Error(`${beside().map(one => path.basename(one)).join(' and ')} still beside the catalog — something else has it open. Stop it, and run this again`);
};

/** Whether the catalog's writer is running. */
const writing = (): Promise<boolean> => running(WRITER);

/** Whether a container is running, as Docker says. */
const running = async (container: string): Promise<boolean> => {
  try {
    const { stdout } = await promisify(execFile)('docker', ['inspect', '-f', '{{.State.Running}}', container], { timeout: 20_000 });

    return stdout.trim() === 'true';
  } catch (err) {
    // No such container is one that is not running. Docker not answering is not knowing.
    if (/No such (object|container)/i.test(String((err as { stderr?: string }).stderr ?? ''))) return false;

    throw new Error(`Cannot tell whether ${container} is running (${(err as Error).message.split('\n')[0]}) — nothing is copied on a guess`);
  }
};

const count = (n: number, what: string): string => `${n.toLocaleString('en-US')} ${what}${n === 1 ? '' : 's'}`;

/** The container that writes the catalog, and how often it is asked after while it is waited for. */
const WRITER    = 'prospector';
const READER    = 'catalog';
const WRITER_MS = 5_000;

/** How long after the log is folded in it is looked for again. */
const SETTLE_MS = 3_000;

/** What the snapshot is called: in the record, in Mega, and in cold's working directory. */
export const SNAPSHOT = 'catalog.db';

/** Everything but the file rows, as one database, and where the partitions' files are: below the catalog's place in Mega. */
export const TABLES     = 'tables.db';
export const PARTITIONS = 'partitions';

/** Partitions written between one line of progress and the next. */
const SAY_EVERY = 250;

/** How often a snapshot still on its way is said to be, and how long before one Mega is not sending is handed over again. */
const SAY_MS = 10 * 60_000;
const ASK_MS = 30 * 60_000;

/** How much of the catalog is copied between one line of progress and the next. */
const SAY_BYTES = 10 * 1024 ** 3;

/** The version of every partition as the snapshot has it, kept beside it until Mega holds it. */
const VERSIONS = 'snapshot.partitions.json';

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_copySnapshot    = copySnapshot;
export const _test_storeSnapshot   = storeSnapshot;
export const _test_writePartitions = writePartitions;
export const _test_deliver         = deliver;
export const _test_whole           = whole;
