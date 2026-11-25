import { discard } from './store';
import type { Haulable, Withheld } from './types';

/**
 * Downloads that did not agree with the catalog, kept until it has been asked.
 *
 * **A file that differs is usually the venue's newer one.** The catalog is told,
 * asks the venue, and takes what the venue says — after which the file is owed
 * again at its new size and checksum, and what was fetched the first time is
 * exactly it. So that download stays in scratch, and when the file comes round
 * again it is set against what the catalog says now: agreeing, it is given its
 * place with nothing fetched; not, it is dropped and fetched like any other.
 *
 * **Looked up by venue and key, never by walking scratch**: what is held is a
 * short list in memory, each entry saying what the download weighed, what it
 * hashed to, and which of its venue's walks held it. It does not outlive the
 * process — scratch is cleared as the service starts, and the list starts empty
 * with it.
 *
 * **What is not listed again is not waited for.** A download is held for a
 * file that is still owed; one that walk after walk is not listed — ruled
 * absent, outside the lens now, or settled some other way — is not the file
 * the catalog settled on, and only takes room on the volume. So whatever was
 * held `STALE_WALKS` walks ago or earlier and not listed since is dropped, and so is
 * everything held of a venue that owes nothing.
 *
 * **A file served unlike its listing walk after walk is asked for less often.**
 * Where the venue keeps serving other bytes than it lists, the listing does not
 * move and each fetch comes to the same. So the first walk a file is served
 * unlike what is listed for it is remembered, by venue and key, with the size
 * and ETag listed then. While it is listed at that same size and ETag, it is
 * fetched on each of the next `EVERY_WALK_FOR` walks of its venue, and after
 * that only on every `THEN_EVERY`th walk since the first — never on none, as fetching it is
 * the only way to find the venue serving the listed file again. On the other
 * walks it is not asked for at all, and stays owed. A listing that changes
 * starts it afresh, fetched at once; a file that settles is forgotten. This is
 * kept apart from what is held: a download dropped from scratch does not make
 * the venue serve the file any differently. Like what is held, it lives in
 * memory and starts empty with the process.
 */

/** Count the start of one more walk of a venue: what is held from here on is held by it. */
export const startWalk = (venue: string): void => {
  WALKS.set(venue, walkOf(venue) + 1);
};

/** Keep a download that did not agree: it stays in scratch under its destination's name. */
export const hold = (file: Haulable, path: string, bytes: number, digest: string): void => {
  const held = HELD.get(file.venue) ?? new Map<string, Withheld>();

  HELD.set(file.venue, held);
  held.set(file.key, { path, bytes, digest, walk: walkOf(file.venue) });
};

/** What is held for a file, taken off the list: whoever asks decides what becomes of it. */
export const taken = (file: Haulable): Withheld | undefined => {
  const kept = HELD.get(file.venue)?.get(file.key);

  HELD.get(file.venue)?.delete(file.key);

  return kept;
};

/**
 * Drop what was held of a venue `walks` walks ago or earlier and not listed
 * since, and answer how many there were. Meant for after a walk that listed
 * everything owed: a walk cut short says nothing of what it did not reach.
 */
export const dropStale = async (venue: string, walks = STALE_WALKS): Promise<number> => {
  const held  = HELD.get(venue);
  const stale = [...held ?? []].filter(([, one]) => one.walk <= walkOf(venue) - walks);

  for (const [key] of stale) held!.delete(key);

  for (const [, one] of stale) await discard(one.path);

  return stale.length;
};

/**
 * Note that a file was served unlike its listing, on this walk of its venue.
 * Listed as it was the last time this was noted, it keeps the walk noted then.
 */
export const servedUnlike = (file: Haulable): void => {
  if (sameListing(UNLIKE.get(file.venue)?.get(file.key), file)) return;

  const venue = UNLIKE.get(file.venue) ?? new Map<string, Unlike>();

  UNLIKE.set(file.venue, venue);
  venue.set(file.key, { size: file.size, etag: file.etag, walk: walkOf(file.venue) });
};

/**
 * Whether a file is to be fetched on this walk of its venue: always, unless it
 * was served unlike its listing and is listed the same since — then on each of
 * the `EVERY_WALK_FOR` walks after the one that noted it, and on every
 * `THEN_EVERY`th walk since it after that. A listing that changed forgets what was noted.
 */
export const fetchDue = (file: Haulable): boolean => {
  const noted = UNLIKE.get(file.venue)?.get(file.key);

  if (! noted) return true;

  if (! sameListing(noted, file)) {
    forgetUnlike(file);

    return true;
  }

  const since = walkOf(file.venue) - noted.walk;

  return since <= EVERY_WALK_FOR || since % THEN_EVERY === 0;
};

/** Forget that a file was served unlike its listing: it is in place, as listed. */
export const forgetUnlike = (file: Haulable): void => {
  const venue = UNLIKE.get(file.venue);

  venue?.delete(file.key);

  if (venue?.size === 0) UNLIKE.delete(file.venue);
};

/** Drop everything held of a venue, and answer how many there were. */
export const dropHeld = async (venue: string): Promise<number> => {
  const held = [...HELD.get(venue)?.values() ?? []];

  HELD.delete(venue);

  for (const one of held) await discard(one.path);

  return held.length;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Walks after the one that held a download, its file listed in none, before it is dropped. */
const STALE_WALKS = 2;

const HELD = new Map<string, Map<string, Withheld>>();

/** Walks after the one a file was first served unlike its listing on which it is still fetched each time. */
const EVERY_WALK_FOR = 3;

/** Past those, how many walks apart it is fetched while its listing stays the same. */
const THEN_EVERY = 10;

/** A file served unlike its listing: the size and ETag listed then, and the walk of its venue that first saw it. */
interface Unlike {
  size: number | undefined;
  etag: string | undefined;
  walk: number;
}

const UNLIKE = new Map<string, Map<string, Unlike>>();

/** Whether a file is listed at the size and ETag that were noted of it. */
const sameListing = (noted: Unlike | undefined, file: Haulable): boolean =>
  noted !== undefined && noted.size === file.size && noted.etag === file.etag;

/** How many walks of each venue have started. */
const WALKS = new Map<string, number>();

const walkOf = (venue: string): number => WALKS.get(venue) ?? 0;

// ── Test access ───────────────────────────────────────────────────────────────

/** Forget every file noted as served unlike its listing. */
export const _test_forgetUnlike = (): void => { UNLIKE.clear(); };
