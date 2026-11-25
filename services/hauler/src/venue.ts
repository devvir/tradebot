import { logger } from '@devvir/service-kit';
import { page, report } from './catalog';
import { LARGE_BYTES, haul } from './fetch';
import { readyAt } from './hosts';
import { roomOn, roomRefusedAt } from './store';
import config from './config';
import type { BucketObject, BucketPage, Haulable, Hauled, Leaf, Pacing, Walked } from './types';

/**
 * Walk a venue's prefix of the catalog's bucket once, end to end, fetching every object it lists.
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
 * **Large files are taken as their turns allow, and the rest meanwhile.** A
 * large file listed when every turn for large files is taken is set aside, and
 * the files behind it are taken; the ones set aside go first once a turn for
 * them is free, and are waited for only where nothing else is ready — a page
 * listed meanwhile is taken at once.
 *
 * **A server turning every request away is waited out holding no turn.** Its
 * files are set aside until one of its addresses is back, and the files of the
 * venue's other servers are taken meanwhile; a file that must wait once begun
 * gives its turns back while it waits: the budget goes to whoever can use it,
 * of this venue or any other.
 *
 * **Stopping takes no new file**: the files in flight finish, for as long as
 * the process is given, and every page reports what it got through, so nothing
 * done goes unreported. A file waiting — for its server, or between attempts —
 * asks nothing more, and is left owed.
 *
 * **So does a volume running low** — below `minFreeGb`, out of inodes, or
 * refusing a write for want of room: no new file is taken, the ones in flight
 * finish, and the walk ends saying so — rather than filling the volume and
 * failing every file after.
 *
 * **It says what it is doing as it goes**: when it asks the catalog, which can
 * take a while on a large venue, and what each page came to. A walk is hours of
 * work, and silence reads as either nothing happening or something unlogged.
 */
export const walkVenue = async (venue: string, stopped: () => boolean): Promise<Walked> => {
  const walked: Walked = {
    listed: 0, progressed: 0, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false,
  };
  const queue: Queued[] = [];

  /** Large files taken from the queue while every turn for one was taken: first to go once one is free. */
  const parked: Queued[] = [];

  /** Files of a server with every address out of rotation, by server, and how many: taken again once one is back. */
  const aside = new Map<string, Queued[]>();
  let away    = 0;

  /** Files listed and not yet taken, wherever they wait. */
  const ahead = (): number => queue.length + parked.length + away;

  const open  = new Set<Leaf>();
  const waiting: (() => void)[] = [];

  let listing = true;
  let pages   = 0;
  let broken  = false;

  /** Wake whoever is waiting: a worker for files, or the lister for room. */
  const stir = (): void => { for (const wake of waiting.splice(0)) wake(); };
  const rest = (): Promise<void> => new Promise(wake => waiting.push(wake));
  const done = (): boolean => broken || stopped() || walked.full;

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
      logger.info({
        venue, page: ++pages, ...walked, more: (listing || ahead() > 0) && ! walked.full,
      }, 'Page done');
  };

  /** List page after page, never holding more than `AHEAD` of them unfetched. */
  const list = async (): Promise<void> => {
    let after: string | null = null;

    try {
      for (let first = true; ! done(); first = false) {
        const current: BucketPage = await page(venue, after);

        if (first) {
          walked.nothingOwed = current.Contents.length === 0 && ! current.IsTruncated;

          logger.info({ venue, owed: current.Contents.length, more: current.IsTruncated },
            current.Contents.length === 0 ? 'Nothing is owed' : 'The catalog answered — fetching');
        }

        const leaf: Leaf = {
          size: current.Contents.length, left: current.Contents.length, unreached: 0,
          done: { downloaded: [], failed: [], mismatched: [] },
        };

        if (leaf.size > 0) open.add(leaf);

        for (const object of current.Contents) queue.push({ object, leaf });

        stir();

        after = current.IsTruncated ? current.NextMarker ?? current.Contents.at(-1)?.Key ?? null : null;

        if (! after) return;

        while (ahead() > AHEAD * current.MaxKeys && ! done()) await rest();
      }
    } finally {
      listing = false;
      stir();
    }
  };

  /**
   * The next file to take: one set aside, where a turn for a large file is
   * free, and otherwise the next listed — a large one setting itself aside
   * where no such turn is free. A large file taken holds its turn for one.
   * The files of a server back in rotation are first in line again.
   */
  const take = (): Queued | null => {
    const now  = Date.now();
    const back: Queued[] = [];

    for (const [server, files] of aside) if (readyAt(venue, server) <= now) {
      aside.delete(server);
      back.push(...files);
    }

    if (back.length > 0) {
      away -= back.length;
      queue.unshift(...back);
    }

    if (parked.length > 0 && tryLargeTurn()) return parked.shift()!;

    for (let next = queue.shift(); next; next = queue.shift()) {
      if (! isLarge(next) || tryLargeTurn()) return next;

      parked.push(next);
    }

    return null;
  };

  /** A file taken and not begun, put back first in line, with its turn for a large file. */
  const putBack = (next: Queued): void => {
    if (isLarge(next)) {
      handBackLarge();
      parked.unshift(next);
    } else {
      queue.unshift(next);
    }

    stir();
  };

  /** A file taken and not begun whose server has every address out: set aside with that server's, its turn for a large file given back. */
  const setAside = (next: Queued, server: string): void => {
    if (isLarge(next)) handBackLarge();

    const files = aside.get(server);

    if (files) files.push(next);
    else aside.set(server, [next]);

    away++;
  };

  /**
   * Wait for something to take: a page listed, a turn for a large file given
   * back, or an address back in rotation for a file set aside. Where anything
   * waits to be taken, looked at again within a second, so that a walk done is
   * seen.
   */
  const idle = async (): Promise<void> => {
    let wake = (): void => undefined;

    const woken = new Promise<void>(resolve => { wake = resolve; });

    waiting.push(wake);

    if (parked.length > 0) largeFreed.push(wake);

    const soonest = Math.min(...[...aside.keys()].map(server => readyAt(venue, server)));
    const timer   = parked.length + away > 0
      ? setTimeout(wake, Math.max(0, Math.min(soonest - Date.now(), WAKE_MS)))
      : undefined;

    try {
      await woken;
    } finally {
      clearTimeout(timer);
      unlist(waiting, wake);
      unlist(largeFreed, wake);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (done()) {
        // The lister may be waiting for room that nobody will make now.
        stir();

        return;
      }

      const next = take();

      // Nothing to take now: whatever is set aside, or still to be listed, is waited for.
      if (! next) {
        if (! listing && parked.length + away === 0) return;

        await idle();
        continue;
      }

      stir();

      if (await low()) {
        walked.full = true;
        putBack(next);

        return;
      }

      const { object, leaf } = next;

      const large  = isLarge(next);
      const server = object.Host ?? '';

      if (readyAt(venue, server) > Date.now()) {
        setAside(next, server);
        continue;
      }

      await turn();

      /** Whether this worker holds its turns: given back while the file waits, taken again before it goes on. */
      let held = true;

      const pacing: Pacing = {
        pause: async (wait) => {
          handBack();

          if (large) handBackLarge();

          held = false;

          try {
            await wait();
          } finally {
            if (large) await largeTurn();

            await turn();

            held = true;
          }
        },
        stopped: done,
      };

      try {
        // Stopped while waiting for a turn: the file is not begun, and its page reports without it.
        if (done()) continue;

        await fetchOne(venue, object, leaf, pacing);
      } finally {
        if (held) {
          handBack();

          if (large) handBackLarge();
        }
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

  /**
   * **A worker that throws stops the walk, and the walk waits for the rest.**
   * Each file's own failure is contained where it is fetched; what reaches here
   * is a fault of the walk itself. The others take nothing new and finish what
   * they hold, and the walk settles only once nothing of it runs.
   */
  const working = await Promise.allSettled(Array.from({ length: config.concurrency }, () => worker().catch((err: unknown) => {
    broken = true;
    stir();

    throw err;
  })));

  const failed = await listed;

  // A listing that failed before anything was listed is a walk that failed; later, the walk got as far as it got.
  if (failed && open.size === 0 && pages === 0) throw failed;
  if (failed) {
    walked.cut = true;

    logger.warn({ venue, err: failed }, 'Listing ended early');
  }

  // What a stop or a full volume left part-done still reports what it got through;
  // a page held ready and never begun was not walked at all.
  for (const leaf of [...open]) if (leaf.left < leaf.size) await settle(leaf);

  const fault = working.find(one => one.status === 'rejected');

  if (fault) throw fault.reason;

  return walked;
};

// ── Internals ──────────────────────────────────────────────────

/** One listed file waiting to be taken, and the page it belongs to. */
interface Queued {
  object: BucketObject;
  leaf:   Leaf;
}

const isLarge = (one: Queued): boolean => (one.object.Size ?? 0) >= LARGE_BYTES;

/** How long a wait for a server sleeps at most before it looks again at whether the walk is done. */
const WAKE_MS = 1_000;

/**
 * Fetches in flight across every venue, and who is waiting for a turn.
 *
 * **`config.concurrency` is the machine's budget, not each venue's.** What it
 * protects is the link: connections are opened through one router whatever
 * venue they go to, and seven venues walking at once at a hundred each is seven
 * hundred, which is where connections start timing out before they open. A
 * venue walking alone has the whole budget; several share it in the order they
 * asked. A turn is held only while a file is being fetched: a file waiting to
 * ask again holds none.
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
  if (tryLargeTurn()) return;

  await new Promise<void>(next => queuedLarge.push(next));
};

/** A turn for a large file where one is free now, without waiting: whether there was one. */
const tryLargeTurn = (): boolean => {
  if (flyingLarge >= LARGE_AT_ONCE) return false;

  flyingLarge++;

  return true;
};

/** Walks with large files set aside and nothing else to take, woken when a turn for one is given back to nobody. */
const largeFreed: (() => void)[] = [];

/** Give the turn for a large file to whoever has waited longest for it, or back, waking the walks that could take it. */
const handBackLarge = (): void => {
  const next = queuedLarge.shift();

  if (next) {
    next();

    return;
  }

  flyingLarge--;

  for (const wake of largeFreed.splice(0)) wake();
};

/** Take one out of a list of wakers, where it is still in it. */
const unlist = (list: (() => void)[], one: () => void): void => {
  const at = list.indexOf(one);

  if (at >= 0) list.splice(at, 1);
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

/** Bring one listed object to disk, waiting as `pacing` has it, and note on its page what came of it. */
const fetchOne = async (venue: string, object: BucketObject, leaf: Leaf, pacing: Pacing): Promise<void> => {
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

  let hauled: Hauled;

  try {
    hauled = await haul(file, pacing);
  } catch (err) {
    logger.error({ venue, key: object.Key, err }, 'Could not haul — stays owed');

    leaf.unreached++;

    return;
  }

  if (hauled.outcome === 'downloaded' || hauled.outcome === 'present') leaf.done.downloaded.push(object.Key);
  else if (hauled.outcome === 'failed') leaf.done.failed.push(object.Key);
  else if (hauled.outcome === 'unreached') leaf.unreached++;
  else leaf.done.mismatched.push({
    Key: object.Key,
    ...(hauled.size === undefined ? {} : { Size: hauled.size }),
    ...(hauled.etag === undefined ? {} : { ETag: hauled.etag }),
  });
};

/**
 * Whether the archives' volume is below the floor: under `minFreeGb` free,
 * under `MIN_FREE_INODES` or half a percent of its inodes free, or a write
 * refused for want of room within `REFUSED_MS`. Asked before every file, and
 * answered from the last look where that was under a second ago: files are
 * taken many at a time, and the volume does not move that fast. A look that
 * fails answers what the last one said, and is tried again a second later.
 *
 * **A refusal is the volume full whatever a look at it says**: a quota is not
 * in it, and a volume can fill between two looks. For long enough to end every
 * walk in flight; the next walk looks afresh.
 */
const low = async (): Promise<boolean> => {
  if (Date.now() - roomRefusedAt() < REFUSED_MS) return true;

  if (Date.now() - looked.at > LOOK_MS) {
    const at = Date.now();

    try {
      const { gb, inodes } = await roomOn(config.archivesDir);

      looked = {
        at,
        low: gb < config.minFreeGb || (inodes.all > 0 && inodes.free < Math.max(MIN_FREE_INODES, inodes.all * 0.005)),
      };
    } catch (err) {
      logger.error({ err, dir: config.archivesDir }, 'Could not look at the archives volume — going by the last look');

      looked = { at, low: looked.low };
    }
  }

  return looked.low;
};

/** How long one look at the volume answers for. */
const LOOK_MS = 1_000;

/** Free inodes below which the volume is low, however large it is. */
const MIN_FREE_INODES = 10_000;

/** How long a write refused for want of room says the volume is full. */
const REFUSED_MS = 60_000;

let looked = { at: 0, low: false };

/** A key stays inside its venue's folder: under the venue asked for, and no step upward. */
const safe = (venue: string, key: string): boolean =>
  key.startsWith(`${venue}/`) && ! key.split('/').some(part => part === '' || part === '..' || part === '.');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_safe = safe;

/** Look at the volume afresh, where a test has just changed what counts as low. */
export const _test_lookAgain = (): void => { looked = { at: 0, low: false }; };

/** Turns held and waited for across every walk: all nothing once no walk runs. */
export const _test_turns = () => ({
  flying, queued: queued.length, flyingLarge, queuedLarge: queuedLarge.length, largeFreed: largeFreed.length,
});
