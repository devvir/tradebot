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
 * short list in memory, each entry saying what the download weighed and what
 * it hashed to. It does not outlive the process — scratch is cleared as the
 * service starts, and the list starts empty with it.
 *
 * **A venue with nothing owed has nothing to wait for**, so whatever is still
 * held of it then is dropped: it is not the file the catalog settled on.
 */

/** Keep a download that did not agree: it stays in scratch under its destination's name. */
export const hold = (file: Haulable, path: string, bytes: number, digest: string): void => {
  const held = HELD.get(file.venue) ?? new Map<string, Withheld>();

  HELD.set(file.venue, held);
  held.set(file.key, { path, bytes, digest });
};

/** What is held for a file, taken off the list: whoever asks decides what becomes of it. */
export const taken = (file: Haulable): Withheld | undefined => {
  const kept = HELD.get(file.venue)?.get(file.key);

  HELD.get(file.venue)?.delete(file.key);

  return kept;
};

/** Drop everything held of a venue, and answer how many there were. */
export const dropHeld = async (venue: string): Promise<number> => {
  const held = [...HELD.get(venue)?.values() ?? []];

  HELD.delete(venue);

  for (const one of held) await discard(one.path);

  return held.length;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const HELD = new Map<string, Map<string, Withheld>>();
