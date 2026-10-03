import { accepted, catalogable, descend } from './descend';
import type { Limits, ListingContext, ReadLevel, S3Page, Scanner } from '../types';

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

  /**
   * **A page covers everything from the marker it was asked with through the
   * marker it hands back** — keys sort, and S3 answers in that order — or to
   * the scope's end on the last page. So whatever is catalogued there and was
   * not listed has been withdrawn; see `Coverage`.
   */
  page: async (context, scope, cursor) => {
    const url  = listingUrl(context.base, scope, cursor, false);
    const page = await context.page(url, 's3');

    return { listed: page.listed, cursor: page.next, covers: { after: cursor, through: page.next } };
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
    const page  = await context.page(listingUrl(context.base, context.keyRoot + path, null, false), 's3');
    const found = page.listed.find(row => row.key === context.keyRoot + path);

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
 * **Until the first file, and no further.** From that page on nothing read
 * here changes the answer — and on a flat directory, which is what every gate
 * month is, "to the end" meant listing the whole month to learn what its first
 * page said. Measured 2026-09-28: 1,965 requests and 46 minutes to split
 * `spot/orderbooks/202602/`, with every idle lane waiting on the answer and the
 * partition itself stopped for it.
 *
 * **A prefix holding files is split by character, not by directory.** A folder
 * split would leave the files sitting directly here in no partition, but S3
 * takes any string as a prefix, so `…/202505/` divides into `…/202505/A`,
 * `…/202505/B` and so on — which together cover every key beneath it, files and
 * directories alike. Without this a flat month was one serial walk however
 * many lanes stood idle: gate's books walked at one or two requests a second
 * for hours. The characters are read off the listing (`initials`) rather than
 * assumed, because gate publishes symbols written in Chinese.
 *
 * The one key a character split cannot hold is the prefix itself, so a prefix
 * that is a catalogable key of its own stays whole.
 *
 * Refused directories are dropped **here**, before the caller counts them, so a
 * prefix is judged on the children that count.
 */
const level: ReadLevel = async (context, prefix) => {
  const children: string[] = [];

  let files  = false;
  let itself = false;
  let cursor: string | null = null;

  do {
    const page: S3Page = await context.page(listingUrl(context.base, prefix, cursor, true), 's3');

    children.push(...page.prefixes.filter(child => accepted(context, child)));
    files  ||= page.listed.some(entry => catalogable(context, entry.key));
    itself ||= page.listed.some(entry => entry.key === prefix && catalogable(context, entry.key));
    cursor = page.next;

  } while (cursor && ! files);

  if (! files || itself) return { children, files };

  const split = await initials(context, prefix);

  return split ? { children: split, files: false } : { children, files };
};

/**
 * Every character a key under this prefix continues with, as prefixes one
 * character longer — between them, every key there is.
 *
 * **One request per character, by skipping.** Ask for the first key after a
 * marker, take the character it continues with, then move the marker past every
 * key sharing it and ask again. A flat month of tens of thousands of files is
 * answered in a few dozen requests, however large it is.
 *
 * The marker past a character is that character followed by the last code point
 * there is, which no published key carries.
 *
 * **Null where the venue does not honour the marker**, which a key at or before
 * it says: the prefix then stays whole rather than being split on a list that
 * could be short — or asked about for ever.
 */
const initials = async (context: ListingContext, prefix: string): Promise<string[] | null> => {
  const found: string[] = [];

  let marker: string | null = null;

  for (;;) {
    const page: S3Page = await context.page(listingUrl(context.base, prefix, marker, false, 1), 's3');
    const key  = page.listed[0]?.key;

    if (key === undefined || ! key.startsWith(prefix) || key.length === prefix.length) return found;

    if (marker !== null && key <= marker) return null;

    const next = String.fromCodePoint(key.codePointAt(prefix.length)!);

    found.push(prefix + next);
    marker = prefix + next + LAST;
  }
};

/** The last code point Unicode has; nothing sorts after it within a character. */
const LAST = '\u{10FFFF}';

const listingUrl = (
  base:      string,
  prefix:    string,
  marker:    string | null,
  delimiter: boolean,
  maxKeys = MAX_KEYS,
): string =>
  // Prefix and marker go in **unencoded**: KuCoin serves its HTML page instead
  // of the XML listing when the slashes are percent-encoded, and S3 accepts the
  // raw form everywhere. Anything outside ASCII is encoded by `fetch` itself.
  `${base.replace(/\/$/, '')}/?prefix=${prefix}&max-keys=${maxKeys}`
  + (delimiter ? '&delimiter=/' : '')
  + (marker ? `&marker=${marker}` : '');

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_listingUrl  = listingUrl;
export const _test_descend     = (context: ListingContext, limits: Limits) =>
  descend(context, limits, level);
export const _test_catalogable = catalogable;
export const _test_accepted    = accepted;
export const _test_level       = (context: ListingContext, prefix: string) => level(context, prefix);
