import { logger } from '@devvir/service-kit';
import { accepted, catalogable, descend } from './descend';
import { metadataOf } from '../etag';
import { Refused } from '../http';
import { ceiling } from '../paths';
import type { Entries, ListingContext, Listed, ReadLevel, Scanner } from '../types';

/**
 * An archive published as **browsable HTML directory indexes** — the page a
 * plain file server renders when there is no index.html, one `<a href>` per
 * entry and nothing else.
 *
 * Written against bybit, which is the only venue on it today, and deliberately
 * kept to what any such index has in common: links, and whether a link names a
 * directory. A second venue of this kind will need its own dialect handled here
 * rather than a second scanner.
 *
 * Three properties separate it from an S3 listing, and each one costs something:
 *
 * - **A listing carries no metadata.** No size, no ETag, no last-modified — the
 *   index names files and stops. Those columns land null, and settling them
 *   would be a HEAD per file, which is the probe scanner's job and not something
 *   to do to millions of keys in passing.
 * - **There is no marker to page with.** A directory answers in full or not at
 *   all, so the unit of a request is a directory rather than a slice of the
 *   keyspace, and a walk is a tree traversal instead of a straight line.
 * - **A directory is not always marked as one.** bybit's `trading/` links its
 *   children with a trailing slash and `spot/` links them without one, in the
 *   same bucket, so a link's shape is what has to be read — see `isDirectory` in `pages.ts`.
 */
export const html: Scanner<ListingContext> = {
  name: 'html',

  /** A job maps its scopes first, so the directories it walks are the ones it read — see `known`. */
  scopes: (context, limits) => {
    forget(context);

    return descend(context, limits, level);
  },

  level: (context, prefix) => level(context, prefix),

  /**
   * One directory's files, and where to resume.
   *
   * **The cursor is the directory just read, and that is the whole state.**
   * Directories are visited in the order their paths sort, so everything at or
   * below the cursor is done and the next page is the first directory above it —
   * which is derivable from the tree itself, with nothing to remember. A run
   * killed mid-walk therefore resumes from one short string, exactly like a
   * marker on an S3 venue.
   *
   * Whether anything follows is settled before answering, so the last directory
   * of a scope ends the walk instead of costing an empty page. That look-ahead
   * is free: everything it consults was read on the way down.
   *
   * **A directory that is gone is passed over, and covers nothing.** Its parent
   * listed it and it now answers `404`, so it is either withdrawn — which the
   * parent's next reading states — or briefly missing at the edge, which must
   * not withdraw a subtree. Either way the walk moves on to its next sibling.
   */
  page: async (context, scope, cursor) => {
    const at = await next(context, scope, cursor);

    if (! at) return { listed: [], cursor: null };

    const { keys, linked, gone } = await read(context, at, scope);
    const after                    = await next(context, scope, at);

    if (gone) {
      logger.warn({ venue: context.name, directory: at }, 'A listed directory is gone; passing over it');

      return { listed: [], cursor: after ? at : null };
    }

    /**
     * **A directory states its own files and its children in full**, and every
     * directory of the scope gets a page, files or not — so what this one no
     * longer offers, file or subdirectory, has been withdrawn. See `Coverage`.
     *
     * **What it links, not what the walk enters.** A refused child is still
     * served, so it is covered as linked even though nothing descends into it.
     */
    return { listed: keys.map(listed), cursor: after ? at : null, covers: { directory: at, children: linked } };
  },

  /**
   * **A HEAD, because there is no listing to ask.** An index names files and
   * says nothing about them, so the only way to learn a key's size or checksum
   * — now or ever — is to ask the file itself. This is the same request the
   * probe makes; what differs is that here somebody is checking a claim rather
   * than filling a blank.
   */
  confirm: async (context, path) => {
    const { status, headers } = await context.head(urlOf(context.base, context.keyRoot + path));

    if (status < 200 || status > 299) return { status, headers };

    return { key: path, ...metadataOf(headers) };
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The child directories of prefixes already visited, so a walk pays for each
 * directory once.
 *
 * Reading a directory records its children here, and the traversal below only
 * ever asks about directories it has already visited — a parent is read before
 * its children, always. A venue's entries are dropped when a job maps its scopes
 * (`forget`), so what is answered from here was read by the job asking, or — on
 * a resume after a restart — is read again on the way back to the cursor.
 *
 * A directory that answered `404` is recorded with no children, so the walk
 * passes it by rather than asking again.
 *
 * It holds directory names only, never the files, so a venue of a few thousand
 * directories costs a few thousand short strings. Keys carry the venue, because
 * two venues serving indexes will both have a `spot/`.
 */
const known = new Map<string, string[]>();

const remembered = (context: ListingContext, prefix: string): string => `${context.name}:${prefix}`;

/** Drop everything `known` holds for a venue, so its next job reads its directories afresh. */
export const forget = (context: ListingContext): void => {
  const mine = `${context.name}:`;

  for (const key of known.keys()) if (key.startsWith(mine)) known.delete(key);
};

/**
 * The first directory that sorts after `cursor`, or the scope itself when there
 * is no cursor yet.
 *
 * Depth-first with children in sorted order visits paths in exactly the order
 * they sort — a parent, then everything beneath it, then its next sibling — so
 * "where was I" is one comparison rather than a stack of positions. A subtree
 * that ends before the cursor is skipped without being opened at all, which is
 * what makes resuming cost a request per level rather than a re-walk.
 */
const next = async (
  context: ListingContext,
  scope:   string,
  cursor:  string | null,
): Promise<string | null> => {
  if (! cursor) return scope;

  const search = async (dir: string): Promise<string | null> => {
    if (dir > cursor) return dir;

    for (const child of await children(context, dir, scope)) {
      // Everything under this child sorts below its ceiling, so a child whose
      // whole subtree ends before the cursor cannot hold the answer.
      if (ceiling(child) <= cursor) continue;

      const found = await search(child);

      if (found) return found;
    }

    return null;
  };

  return search(scope);
};

/** A directory's children, from what a visit already learned where possible. */
const children = async (context: ListingContext, dir: string, scope: string): Promise<string[]> =>
  known.get(remembered(context, dir)) ?? (await read(context, dir, scope)).children;

/**
 * One directory, read: `children` to descend into, and `linked`, every child it
 * links whether accepted or not. `gone` where it answered `404` instead.
 */
type Reading = Entries & { linked: string[]; gone?: true };

/**
 * Read one directory: the child directories worth descending into, and the keys
 * sitting in it.
 *
 * Refused directories are dropped here, before anyone counts them, so a prefix
 * is judged on the children that count and a refused tree is never opened.
 *
 * **A `404` below the scope is a directory that is gone**, read as one with
 * nothing in it and marked so. The scope itself, or a directory read with no
 * scope, has no parent here to have listed it, so its `404` stays a failure.
 */
const read = async (
  context: ListingContext,
  prefix:  string,
  scope?:  string,
): Promise<Reading> => {
  let entries: Entries;

  try {
    entries = await context.page(urlOf(context.base, prefix), 'index', prefix);
  } catch (err) {
    if (! (err instanceof Refused) || err.status !== 404 || scope === undefined || prefix === scope) throw err;

    known.set(remembered(context, prefix), []);

    return { children: [], linked: [], keys: [], gone: true };
  }

  /**
   * **Sorted here, because a server's order is not ours.** The walk moves
   * forward through paths in byte order and never looks back, so a child
   * arriving out of that order is skipped for good — silently, and while the
   * job still closes as established.
   *
   * Nothing exotic is needed to hit it. Bybit sorts by the bare name, while a
   * child is compared as a path with its trailing slash, and `-` sorts before
   * `/`: served, `BTCUSDT/` precedes `BTCUSDT-01AUG25/`, and as paths the two
   * are the other way round. Nine such inversions in `trading/` stranded 401
   * of its 1,882 symbols.
   *
   * So the order is imposed rather than assumed, and no index has to promise
   * anything.
   */
  const linked = [...entries.children].sort();

  const found: Entries = {
    children: linked.filter(child => accepted(context, child)),
    keys:     entries.keys,
  };

  known.set(remembered(context, prefix), found.children);

  return { ...found, linked };
};

const level: ReadLevel = async (context, prefix) => {
  const { children, keys } = await read(context, prefix);

  return { children, files: keys.some(key => catalogable(context, key)) };
};

/**
 * A path as a URL on the server, **each segment encoded**. Names are held
 * decoded, so a `#`, `?` or `%` in one would otherwise end the path or start an
 * escape.
 */
const urlOf = (base: string, path: string): string =>
  `${base.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * An index names a file and says nothing else about it, so everything but the
 * path is unknown here. A HEAD would answer all three, and doing that per file
 * is the probe scanner's business rather than something to slip into a walk.
 */
const listed = (key: string): Listed => ({ key, size: null, etag: null, modified: null });

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_next        = next;
export const _test_known       = known;
export const _test_urlOf       = urlOf;
