import { posix } from 'node:path';
import { etagOf } from '../etag';
import { flat } from '../paths';
import type { Entries, Listed, ListingPage, Malformed, PageRead, S3Page } from '../types';

/**
 * A listing page read into what a scanner walks, from the text a venue sent.
 *
 * **Apart from the scanners, because it runs where the page arrives.** Reading
 * a page is a pure function of its text, and a listing runs to megabytes, so it
 * is done by the transport as the body lands — off the thread that writes the
 * catalog — and what crosses back is the reading, not the page. See
 * `transport.ts`.
 *
 * **A body that is not a listing reads as `Malformed`, never as an empty one.**
 * An empty listing is a statement — nothing is here — and a maintenance page, an
 * error document served with a 200 or a body cut short would otherwise make it.
 * So each format is recognised by its own shape before a single entry is taken
 * from it.
 */
export const readPage = (read: PageRead, text: string): ListingPage =>
  read.format === 's3' ? s3Page(text) : indexPage(text, read.prefix);

// ── Internals ─────────────────────────────────────────────────────────────────

const s3Page = (xml: string): S3Page | Malformed => {
  if (! /<ListBucketResult[\s>]/.test(xml)) return malformed('no <ListBucketResult>', xml);

  /** Every listing says whether it held anything back, so one that does not is not a listing. */
  const truncation = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml)?.[1];

  if (truncation === undefined) return malformed('no <IsTruncated>', xml);

  const listed: Listed[] = [];

  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tag(body, 'Key');

    if (! key) continue;

    listed.push({
      key,
      size:     number(tag(body, 'Size')),
      etag:     etagOf(tag(body, 'ETag')),
      modified: tag(body, 'LastModified') ?? null,
    });
  }

  // Child directories arrive as `<CommonPrefixes><Prefix>`. The reply also
  // carries a bare top-level `<Prefix>` echoing the request, which ends in `/`
  // like the rest — matching `<Prefix>` alone turns it into a phantom child
  // named after the last path segment, on every S3 venue.
  const prefixes = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)]
    .map(m => flat(unxml(m[1]!)));

  const truncated = truncation === 'true';
  const found     = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
  const declared  = found === undefined ? null : flat(unxml(found));

  // S3 omits NextMarker when no delimiter was sent, and then the marker is the
  // last entry of the page — the greater of its last key and its last child
  // directory, since a truncated level can end on either. Without this a walk
  // stops after its first page and reports success.
  const last = [listed[listed.length - 1]?.key, prefixes[prefixes.length - 1]]
    .filter((entry): entry is string => entry !== undefined)
    .sort()
    .pop() ?? null;

  const next = truncated ? (declared ?? last) : null;

  // Held back, with nothing to resume from: the rest of this listing is unreachable.
  if (truncated && next === null) return malformed('truncated with no entries and no marker', xml);

  return { listed, prefixes, next };
};

/**
 * One tag's contents, **copied rather than sliced**.
 *
 * Every string this scanner hands out passes through here or through the two
 * captures above, which is why the copy lives here: a regex capture in V8 points
 * into the page it was matched against, and these outlive the page by a long way
 * — a key becomes a series' symbol and is held for the life of the process. One
 * kept capture pins the whole half-megabyte listing. See `flat`.
 *
 * Unescaped as well: XML writes `&` in a key as `&amp;`, and the key is the
 * text, not its spelling.
 */
const tag = (xml: string, name: string): string | null => {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

  return found === undefined ? null : flat(unxml(found));
};

/**
 * XML's five named entities and its character references, decoded **in one
 * pass**, so an escaped escape — `&amp;lt;` — stays the literal `&lt;` it spells.
 */
const unxml = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (whole, name: string) => {
    const named = ENTITIES[name.toLowerCase()];

    if (named !== undefined) return named;

    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);

    return code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
  });

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Why a body is not a listing, with how it begins, short enough to log. */
const malformed = (reason: string, text: string): Malformed =>
  ({ malformed: flat(`${reason}: ${JSON.stringify(text.slice(0, SNIPPET))}`) });

const SNIPPET = 200;

const number = (raw: string | null): number | null => {
  if (raw === null) return null;

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Pull the entries out of an index page.
 *
 * Only `href` is read, in any of the three ways HTML lets an attribute be
 * written — double-quoted, single-quoted or bare. The visible text beside it is
 * the same name on every server that renders these pages, and where it is not —
 * a truncated long name — it is the link that is right.
 *
 * **An entry is one name directly inside the directory**, because that is all a
 * directory index lists. Anything else is dropped: the parent link, absolute
 * paths, full URLs, query and fragment links, and any name of more than one
 * segment or of a dot segment — `./` is the same directory under a longer path,
 * which a walk would descend into for ever, and `x/../` is a different one. What
 * is left is a name, resolved against the directory it was found in.
 *
 * **A page with no entries has to look like an index to count as an empty
 * one**: a parent link, or the `Index of` / `Directory listing` heading the
 * common servers put on these pages. Anything else is `Malformed` — an error or
 * maintenance page has no entries either.
 */
const indexPage = (page: string, prefix: string): Entries | Malformed => {
  const children: string[] = [];
  const keys:     string[] = [];

  let parent = false;

  /**
   * **Copied, not sliced.** A capture points into the page it was matched
   * against, and these outlive it — see `flat`. An index page is smaller than an
   * S3 listing, but the arithmetic is the same and so is the fix.
   */
  for (const [, double, single, bare] of page.matchAll(HREF)) {
    const name = decode(flat((double ?? single ?? bare)!));

    if (name === '..' || name === '../') parent = true;

    if (! inside(prefix, name)) continue;

    const path = prefix + name;

    if (isDirectory(name)) children.push(path.endsWith('/') ? path : `${path}/`);
    else keys.push(path);
  }

  if (! children.length && ! keys.length && ! parent && ! INDEX_HEADING.test(page))
    return malformed('not a directory index', page);

  return { children, keys };
};

/** An anchor's `href`, quoted either way or not at all. */
const HREF = /<a\s(?:[^>]*?\s)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

/** The heading autoindex pages carry: nginx and Apache write `Index of`, Python `Directory listing`. */
const INDEX_HEADING = /<(?:title|h1)[^>]*>\s*(?:Index of|Directory listing)\b/i;

/**
 * Whether a decoded link names one entry directly inside `prefix`: a single
 * segment, optionally ending in `/`, that is not a dot segment and carries
 * nothing a URL would read as structure.
 */
const inside = (prefix: string, name: string): boolean => {
  const segment = name.endsWith('/') ? name.slice(0, -1) : name;

  if (segment === '' || segment === '.' || segment === '..' || /[/?#\\]/.test(segment)) return false;

  const resolved = posix.normalize(prefix + segment);

  return resolved.startsWith(prefix) && resolved !== prefix;
};

/**
 * Whether a link names a directory rather than a file.
 *
 * A trailing slash settles it, and where a server omits one — bybit's `spot/`
 * tree links `BTCUSDT` where `trading/` links `BTCUSDT/` — the extension does:
 * every published file carries one, and no directory in an archive of symbols,
 * years and datasets does. A directory misread as a file costs a subtree; a file
 * misread as a directory is asked for as one, and answered with a `404`.
 */
const isDirectory = (name: string): boolean =>
  name.endsWith('/') || ! name.slice(name.lastIndexOf('/') + 1).includes('.');

/** Entities, then percent-encoding: the two escapes a server puts in an href. */
const decode = (href: string): string => {
  const entities = unxml(href);

  try {
    return decodeURIComponent(entities);
  } catch {
    // A stray `%` is a name, not an escape. Better the raw link than nothing.
    return entities;
  }
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_isDirectory = isDirectory;
