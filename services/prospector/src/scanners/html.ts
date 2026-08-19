import { accepted, catalogable, descend } from './descend';
import { etagOf } from '../http';
import { ceiling, flat } from '../paths';
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
 *   same bucket, so a link's shape is what has to be read — see `isDirectory`.
 */
export const html: Scanner<ListingContext> = {
  name: 'html',

  scopes: (context, limits) => descend(context, limits, level),

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
   */
  page: async (context, scope, cursor) => {
    const at = await next(context, scope, cursor);

    if (! at) return { listed: [], cursor: null };

    const { keys } = await read(context, at);
    const after    = await next(context, scope, at);

    return { listed: keys.map(listed), cursor: after ? at : null };
  },

  /**
   * **A HEAD, because there is no listing to ask.** An index names files and
   * says nothing about them, so the only way to learn a key's size or checksum
   * — now or ever — is to ask the file itself. This is the same request the
   * probe makes; what differs is that here somebody is checking a claim rather
   * than filling a blank.
   */
  confirm: async (context, path) => {
    const { status, headers } = await context.head(`${context.base.replace(/\/$/, '')}/${context.root}${path}`);

    if (status === 404) return null;

    const size = Number(headers.get('content-length'));

    return {
      key:      path,
      size:     Number.isFinite(size) ? size : null,
      etag:     etagOf(headers.get('etag')),
      modified: headers.get('last-modified'),
    };
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The child directories of prefixes already visited, so a walk pays for each
 * directory once.
 *
 * Reading a directory records its children here, and the traversal below only
 * ever asks about directories it has already visited — a parent is read before
 * its children, always. So an entry is written by this process before it is
 * read, which is what keeps a month-old memory from hiding a symbol added since:
 * nothing is answered from a cache this job did not fill.
 *
 * It holds directory names only, never the files, so a venue of a few thousand
 * directories costs a few thousand short strings. Keys carry the venue, because
 * two venues serving indexes will both have a `spot/`.
 */
const known = new Map<string, string[]>();

const remembered = (context: ListingContext, prefix: string): string => `${context.name}:${prefix}`;

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

    for (const child of await children(context, dir)) {
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
const children = async (context: ListingContext, dir: string): Promise<string[]> =>
  known.get(remembered(context, dir)) ?? (await read(context, dir)).children;

/**
 * Read one directory: the child directories worth descending into, and the keys
 * sitting in it.
 *
 * Refused directories are dropped here, before anyone counts them, so a prefix
 * is judged on the children that count and a refused tree is never opened.
 */
const read = async (
  context: ListingContext,
  prefix:  string,
): Promise<Entries> => {
  const entries = parse(await context.text(directoryUrl(context.list, prefix)), prefix);

  const found: Entries = {
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
    children: entries.children.filter(child => accepted(context, child)).sort(),
    keys:     entries.keys,
  };

  known.set(remembered(context, prefix), found.children);

  return found;
};

const level: ReadLevel = async (context, prefix) => {
  const { children, keys } = await read(context, prefix);

  return { children, files: keys.some(key => catalogable(context, key)) };
};

const directoryUrl = (list: string, prefix: string): string =>
  `${list.replace(/\/$/, '')}/${prefix}`;

/**
 * Pull the entries out of an index page.
 *
 * Only `href` is read. The visible text beside it is the same name on every
 * server that renders these pages, and where it is not — a truncated long name —
 * it is the link that is right.
 *
 * Anything pointing outside the directory is dropped: the parent link, absolute
 * paths, and full URLs. What is left is a name, resolved against the directory
 * it was found in.
 */
const parse = (page: string, prefix: string): Entries => {
  const children: string[] = [];
  const keys:     string[] = [];

  /**
   * **Copied, not sliced.** A capture points into the page it was matched
   * against, and these outlive it — see `flat`. An index page is smaller than an
   * S3 listing, but the arithmetic is the same and so is the fix.
   */
  for (const [, sliced] of page.matchAll(/<a\s[^>]*href="([^"]+)"/gi)) {
    const href = flat(sliced!);

    const name = decode(href!);

    if (! name || name.startsWith('/') || name.startsWith('?') || name.startsWith('#')
        || name.includes('://') || name.startsWith('..')) continue;

    const path = prefix + name;

    if (isDirectory(name)) children.push(path.endsWith('/') ? path : `${path}/`);
    else keys.push(path);
  }

  return { children, keys };
};

/**
 * Whether a link names a directory rather than a file.
 *
 * A trailing slash settles it, and where a server omits one — bybit's `spot/`
 * tree links `BTCUSDT` where `trading/` links `BTCUSDT/` — the extension does:
 * every published file carries one, and no directory in an archive of symbols,
 * years and datasets does. A directory misread as a file costs a subtree; a file
 * misread as a directory costs one wasted request against a 404.
 */
const isDirectory = (name: string): boolean =>
  name.endsWith('/') || ! name.slice(name.lastIndexOf('/') + 1).includes('.');

/** Percent-encoding and the handful of entities a server puts in an href. */
const decode = (href: string): string => {
  const entities = href
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  try {
    return decodeURIComponent(entities);
  } catch {
    // A stray `%` is a name, not an escape. Better the raw link than nothing.
    return entities;
  }
};

/**
 * An index names a file and says nothing else about it, so everything but the
 * path is unknown here. A HEAD would answer all three, and doing that per file
 * is the probe scanner's business rather than something to slip into a walk.
 */
const listed = (key: string): Listed => ({ key, size: null, etag: null, modified: null });

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_parse       = parse;
export const _test_isDirectory = isDirectory;
export const _test_next        = next;
export const _test_known       = known;
