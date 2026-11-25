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

/** How many walks of each venue have started. */
const WALKS = new Map<string, number>();

const walkOf = (venue: string): number => WALKS.get(venue) ?? 0;
