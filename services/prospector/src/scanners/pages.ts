import { etagOf } from '../etag';
import { flat } from '../paths';
import type { Entries, Listed, ListingPage, PageRead, S3Page } from '../types';

/**
 * A listing page read into what a scanner walks, from the text a venue sent.
 *
 * **Apart from the scanners, because it runs where the page arrives.** Reading
 * a page is a pure function of its text, and a listing runs to megabytes, so it
 * is done by the transport as the body lands — off the thread that writes the
 * catalog — and what crosses back is the reading, not the page. See
 * `transport.ts`.
 */
export const readPage = (read: PageRead, text: string): ListingPage =>
  read.format === 's3' ? s3Page(text) : indexPage(text, read.prefix);

// ── Internals ─────────────────────────────────────────────────────────────────

const s3Page = (xml: string): S3Page => {
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
    .map(m => flat(m[1]!));

  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const found     = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1];
  const declared  = found === undefined ? null : flat(found);

  // S3 omits NextMarker when no delimiter was sent, and then the marker is the
  // last entry of the page — the greater of its last key and its last child
  // directory, since a truncated level can end on either. Without this a walk
  // stops after its first page and reports success.
  const last = [listed[listed.length - 1]?.key, prefixes[prefixes.length - 1]]
    .filter((entry): entry is string => entry !== undefined)
    .sort()
    .pop() ?? null;

  const next = truncated ? (declared ?? last) : null;

  return { listed, prefixes, next };
};

/**
 * One tag's contents, **copied rather than sliced**.
 *
 * Every string this scanner hands out passes through here or through the two
 * below, which is why the copy lives here: a regex capture in V8 points into the
 * page it was matched against, and these outlive the page by a long way — a key
 * becomes a series' symbol and is held for the life of the process. One kept
 * capture pins the whole half-megabyte listing. See `flat`.
 */
const tag = (xml: string, name: string): string | null => {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

  return found === undefined ? null : flat(found);
};

const number = (raw: string | null): number | null => {
  if (raw === null) return null;

  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : null;
};

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
const indexPage = (page: string, prefix: string): Entries => {
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

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_isDirectory = isDirectory;
