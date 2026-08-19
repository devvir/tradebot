import { accepted, catalogable, descend } from './descend';
import { etagOf } from '../http';
import { flat } from '../paths';
import type { Limits, ListingContext, Listed, ReadLevel, Scanner } from '../types';

/**
 * A standard S3 bucket listing: `prefix` and `marker` honoured, `delimiter` used
 * to see one level at a time.
 *
 * Shared by every venue that publishes one — binance, HTX and KuCoin today —
 * which is the entire point of separating a scanner from an adapter. Those three
 * differ in a hostname, a root prefix and a date pattern, and in nothing else.
 *
 * Two properties of S3 shape everything here:
 *
 * - **Keys sort lexicographically, and the date is the trailing part of a
 *   filename.** So one symbol's dates are contiguous and dates across symbols
 *   are not, which is why a walk cannot seal a month part-way through and can
 *   seal a whole prefix at once.
 * - **`max-keys` caps at 1000.** Larger values are echoed back in `<MaxKeys>`
 *   and never applied — that echo is the request, not the cap — so anyone
 *   reading the response would conclude it worked.
 */
export const s3: Scanner<ListingContext> = {
  name: 's3',

  scopes: (context, limits) => descend(context, limits, level),

  level: (context, prefix) => level(context, prefix),

  page: async (context, scope, cursor) => {
    const url  = listingUrl(context.list, scope, cursor, false);
    const page = parse(await context.text(url));

    return { listed: page.listed, cursor: page.next };
  },

  /**
   * **The key as its own prefix**, which is the cheapest question a listing
   * venue answers about one file: the reply carries size, ETag and
   * last-modified without a second request, and without the object itself.
   *
   * A prefix can match more than the key that spelled it — `…/A.zip` also
   * matches `…/A.zip.CHECKSUM` — so the exact key is picked out of the reply
   * rather than the first row taken.
   */
  confirm: async (context, path) => {
    const xml   = await context.text(listingUrl(context.list, context.root + path, null, false));
    const found = parse(xml).listed.find(row => row.key === context.root + path);

    return found ?? null;
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

const MAX_KEYS = 1000;

/**
 * What is immediately inside a prefix: the child directories worth descending
 * into, and whether any key sitting directly here is one this venue would
 * catalogue.
 *
 * **Read to `IsTruncated`, not to the first page.** A `delimiter=/` reply is
 * capped at `MAX_KEYS` entries with children and keys sharing that budget, so a
 * level wider than a page arrives cut off — and both answers here would then
 * describe a fraction of it. The dangerous half is `files`: a dated key sorting
 * past the cut would read as "no files here", the prefix would be replaced by its
 * children, and that key would end up inside no partition at all — uncatalogued,
 * and with nothing said about it. S3 states plainly whether it held anything
 * back, so it is asked rather than assumed.
 *
 * Refused directories are dropped **here**, before the caller counts them, so a
 * prefix is judged on the children that count.
 */
const level: ReadLevel = async (context, prefix) => {
  const children: string[] = [];

  let files  = false;
  let cursor: string | null = null;

  do {
    const page = parse(await context.text(listingUrl(context.list, prefix, cursor, true)));

    children.push(...page.prefixes.filter(child => accepted(context, child)));
    files ||= page.listed.some(entry => catalogable(context, entry.key));
    cursor = page.next;

  } while (cursor);

  return { children, files };
};

const listingUrl = (
  list:      string,
  prefix:    string,
  marker:    string | null,
  delimiter: boolean,
): string =>
  // Prefix and marker go in **unencoded**: KuCoin serves its HTML page instead
  // of the XML listing when the slashes are percent-encoded, and S3 accepts the
  // raw form everywhere. Keys are alphanumerics, `/`, `-`, `_` and `.` only.
  `${list.replace(/\/$/, '')}/?prefix=${prefix}&max-keys=${MAX_KEYS}`
  + (delimiter ? '&delimiter=/' : '')
  + (marker ? `&marker=${marker}` : '');

interface Parsed {
  listed:   Listed[];
  prefixes: string[];
  next:     string | null;
}

const parse = (xml: string): Parsed => {
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

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_parse       = parse;
export const _test_listingUrl  = listingUrl;
export const _test_descend     = (context: ListingContext, limits: Limits) =>
  descend(context, limits, level);
export const _test_catalogable = catalogable;
export const _test_accepted    = accepted;
