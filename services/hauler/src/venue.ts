import { logger } from '@devvir/service-kit';
import { page, report } from './catalog';
import { LARGE_BYTES, haul } from './fetch';
import { freeGb } from './store';
import config from './config';
import type { BucketObject, BucketPage, Haulable, Leaf, Walked } from './types';

/**
 * Walk a venue's bucket once, end to end, fetching every object it lists.
 *
 * **A bucket walk, nothing more.** The listing is already narrowed to what is
 * still owed and to the lens, and each key is where its file goes, so this only
 * pages, fetches and reports. A file the catalog adds behind the cursor is
 * listed by the next walk, as on any bucket.
 *
 * **Pages are listed ahead of the fetching and held ready** — `AHEAD` of them —
 * and the files of every page held are one queue, taken `config.concurrency` at
 * a time. So the listing is never what anything waits on, and neither is a
 * page's end: its last slow files hold up nobody, the next page's being taken
 * already. A page is reported the moment its last file settles, whichever
 * page that is.
 *
 * **Stopping takes no new file**: the files in flight finish, for as long as
 * the process is given, and every page reports what it got through, so nothing
 * done goes unreported.
 *
 * **So does a volume running low.** Below `minFreeGb` no new file is taken, the
 * ones in flight finish, and the walk ends saying so — rather than filling the
 * volume and failing every file after.
 *
 * **It says what it is doing as it goes**: when it asks the catalog, which can
 * take a while on a large venue, and what each page came to. A walk is hours of
 * work, and silence reads as either nothing happening or something unlogged.
 */
export const walkVenue = async (venue: string, stopped: () => boolean): Promise<Walked> => {
  const walked: Walked = { listed: 0, progressed: 0, failed: 0, mismatched: 0, unreached: 0, full: false };
  const queue: { object: BucketObject; leaf: Leaf }[] = [];
  const open  = new Set<Leaf>();
  const waiting: (() => void)[] = [];

  let listing = true;
  let pages   = 0;

  /** Wake whoever is waiting: a worker for files, or the lister for room. */
  const stir = (): void => { for (const wake of waiting.splice(0)) wake(); };
  const rest = (): Promise<void> => new Promise(wake => waiting.push(wake));
  const done = (): boolean => stopped() || walked.full;

  logger.info({ venue, lens: config.lens || '(none)' }, 'Walk started — asking the catalog what is owed');

  /** One page settled, whole or as far as the walk got: reported, and counted. */
  const settle = async (leaf: Leaf): Promise<void> => {
    open.delete(leaf);

    await report(venue, leaf.done);

    walked.listed     += leaf.size;
    walked.progressed += leaf.done.downloaded.length;
    walked.failed     += leaf.done.failed.length;
    walked.mismatched += leaf.done.mismatched.length;
    walked.unreached  += leaf.unreached;

    if (leaf.size > 0)
      logger.info({ venue, page: ++pages, ...walked, more: (listing || queue.length > 0) && ! walked.full }, 'Page done');
  };

  /** List page after page, never holding more than `AHEAD` of them unfetched. */
  const list = async (): Promise<void> => {
    let after: string | null = null;

    try {
      for (let first = true; ! done(); first = false) {
        const current: BucketPage = await page(venue, after);

        if (first)
          logger.info({ venue, owed: current.Contents.length, more: current.IsTruncated },
            current.Contents.length === 0 ? 'Nothing is owed' : 'The catalog answered — fetching');

        const leaf: Leaf = {
          size: current.Contents.length, left: current.Contents.length, unreached: 0,
          done: { downloaded: [], failed: [], mismatched: [] },
        };

        if (leaf.size > 0) open.add(leaf);

        for (const object of current.Contents) queue.push({ object, leaf });

        stir();

        after = current.IsTruncated ? current.NextMarker ?? current.Contents.at(-1)?.Key ?? null : null;

        if (! after) return;

        while (queue.length > AHEAD * current.MaxKeys && ! done()) await rest();
      }
    } finally {
      listing = false;
      stir();
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done()) {
        // The lister may be waiting for room that nobody will make now.
        stir();

        return;
      }

      const next = queue.shift();

      if (! next) {
        if (! listing) return;

        await rest();
        continue;
      }

      stir();

      if (await low()) {
        walked.full = true;
        queue.unshift(next);
        stir();

        return;
      }

      const { object, leaf } = next;

      const large = (object.Size ?? 0) >= LARGE_BYTES;

      if (large) await largeTurn();

      await turn();

      try {
        // Stopped while waiting for a turn: the file is not begun, and its page reports without it.
        if (done()) continue;

        await fetchOne(venue, object, leaf);
      } finally {
        handBack();

        if (large) handBackLarge();
      }

      if (--leaf.left === 0) await settle(leaf);
    }
  };

  /**
   * **Held from the moment it starts**, as an outcome and never as a rejection:
   * the listing can fail while files are still being fetched, and a promise that
   * rejects with nobody waiting on it yet ends the process.
   */
  const listed: Promise<unknown> = list().then(() => null, (err: unknown) => err);

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  const failed = await listed;

  // A listing that failed before anything was listed is a walk that failed; later, the walk got as far as it got.
  if (failed && open.size === 0 && pages === 0) throw failed;
  if (failed) logger.warn({ venue, err: failed }, 'Listing ended early');

  // What a stop or a full volume left part-done still reports what it got through;
  // a page held ready and never begun was not walked at all.
  for (const leaf of [...open]) if (leaf.left < leaf.size) await settle(leaf);

  return walked;
};

// ── Internals ──────────────────────────────────────────────────

/**
 * Fetches in flight across every venue, and who is waiting for a turn.
 *
 * **`config.concurrency` is the machine's budget, not each venue's.** What it
 * protects is the link: connections are opened through one router whatever
 * venue they go to, and seven venues walking at once at a hundred each is seven
 * hundred, which is where connections start timing out before they open. A
 * venue walking alone has the whole budget; several share it in the order they
 * asked.
 */
let flying = 0;

const queued: (() => void)[] = [];

const turn = async (): Promise<void> => {
  if (flying < config.concurrency) {
    flying++;

    return;
  }

  await new Promise<void>(next => queued.push(next));
};

/**
 * Large files in flight across every venue, and who is waiting.
 *
 * **A few at a time, whatever the budget.** A large file is bounded by the
 * link and not by the wait for an answer, so a hundred at once arrive no sooner
 * than six — each merely takes as long as all of them, nothing else is fetched
 * meanwhile, and a stop loses every one part-done. Six get the link between
 * them and leave the rest of the budget to the small files, of every venue.
 */
const LARGE_AT_ONCE = 6;

let flyingLarge = 0;

const queuedLarge: (() => void)[] = [];

const largeTurn = async (): Promise<void> => {
  if (flyingLarge < LARGE_AT_ONCE) {
    flyingLarge++;

    return;
  }

  await new Promise<void>(next => queuedLarge.push(next));
};

const handBackLarge = (): void => {
  const next = queuedLarge.shift();

  if (next) next();
  else flyingLarge--;
};

/** Give the turn to whoever has waited longest, or back to the budget. */
const handBack = (): void => {
  const next = queued.shift();

  if (next) next();
  else flying--;
};

/**
 * How many pages are held listed and unfetched before the lister waits. Enough
 * that fetching never catches the listing up, and no more: a page held is a
 * page the catalog may have changed its mind about by the time it is fetched.
 */
const AHEAD = 3;

/** Bring one listed object to disk and note on its page what came of it. */
const fetchOne = async (venue: string, object: BucketObject, leaf: Leaf): Promise<void> => {
  if (! safe(venue, object.Key)) {
    logger.error({ venue, key: object.Key }, 'Key outside the venue — skipped');

    return;
  }

  const file: Haulable = {
    venue,
    key: object.Key,
    server: object.Host ?? '',
    path: object.Path,
    ...(object.Size === undefined ? {} : { size: object.Size }),
    ...(object.ETag === undefined ? {} : { etag: object.ETag }),
  };

  const hauled = await haul(file);

  if (hauled.outcome === 'downloaded' || hauled.outcome === 'present') leaf.done.downloaded.push(object.Key);
  else if (hauled.outcome === 'failed') leaf.done.failed.push(object.Key);
  else if (hauled.outcome === 'unreached') leaf.unreached++;
  else leaf.done.mismatched.push({ Key: object.Key, ...(hauled.size === undefined ? {} : { Size: hauled.size }) });
};

/**
 * Whether the archives' volume is below the floor. Asked before every file,
 * and answered from the last look where that was under a second ago: files are
 * taken many at a time, and the volume does not move that fast.
 */
const low = async (): Promise<boolean> => {
  if (Date.now() - looked.at > LOOK_MS)
    looked = { at: Date.now(), low: await freeGb(config.archivesDir) < config.minFreeGb };

  return looked.low;
};

/** How long one look at the volume answers for. */
const LOOK_MS = 1_000;

let looked = { at: 0, low: false };

/** A key stays inside its venue's folder: under the venue asked for, and no step upward. */
const safe = (venue: string, key: string): boolean =>
  key.startsWith(`${venue}/`) && ! key.split('/').some(part => part === '' || part === '..' || part === '.');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_safe = safe;

/** Look at the volume afresh, where a test has just changed what counts as low. */
export const _test_lookAgain = (): void => { looked = { at: 0, low: false }; };
