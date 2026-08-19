import type { Inspection, Reading } from './types';


/**
 * The two string operations every scanner and the recording step both need, kept
 * in one place because a venue's keyspace and the catalog's paths have to agree
 * about them exactly.
 */

/**
 * A copy of a string that owns its own characters.
 *
 * **A substring in V8 does not copy — it points.** Anything sliced out of a
 * larger string with `slice`, a regex capture or `split` becomes a `SlicedString`
 * holding a reference to its parent, and the parent cannot be collected while any
 * of its children is alive. That is an optimisation right up until one of those
 * children is kept.
 *
 * Here they are kept: a symbol read out of a listing is stored in the series
 * registry for the life of the process, and a cursor is held for the life of a
 * partition. Each one pinned the **entire listing page** it came from — half a
 * megabyte of S3 XML per retained string. Measured on a running service: 1,834
 * listing bodies alive at once, 657 MB of an 792 MB heap, growing by 800 bodies
 * in the twelve minutes between two snapshots.
 *
 * So every string a scanner hands out is copied here, at the boundary, where the
 * cost is a few thousand short copies per page and the alternative is retaining
 * the page. Callers downstream do not have to know which of them keeps what.
 *
 * The round trip through a buffer is the copy: nothing in `String.prototype`
 * reliably forces one, because every method that could is free to return the
 * same object.
 */
export const flat = (value: string): string => Buffer.from(value).toString();

/**
 * A key or prefix with the venue's root removed, as the catalog stores it.
 *
 * Takes the root rather than whoever holds it, so both an adapter and a
 * scanner's context can ask without either depending on the other's shape.
 */
export const relative = (from: { root: string }, key: string): string =>
  key.startsWith(from.root) ? key.slice(from.root.length) : key;

/**
 * The exclusive upper bound of a prefix: the prefix with its last byte
 * incremented, so `spot/` becomes `spot0` — `0` being the byte after `/`.
 *
 * Everything inside a prefix sorts below this. That is what lets a walk skip a
 * whole subtree by comparing two strings rather than opening it, and what lets a
 * query bound a prefix as a range — a range always uses the index, while `LIKE`
 * only does when collation and the `case_sensitive_like` pragma line up, and
 * silently falls back to a full scan when they do not.
 */
export const ceiling = (prefix: string): string =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * Whether a path is excluded at **every** venue, whoever served it.
 *
 * The narrowest of three exclusion tiers, and the only one that needs no venue:
 *
 * | tier | for | where |
 * |---|---|---|
 * | this one | files no venue should ever catalogue | here, in code |
 * | an adapter's `accepts` | one venue's shapes and trees | that adapter |
 * | the `exclusion` table | specific known-bad files, by path | a row, no deploy |
 */
export const excludedAnywhere = (path: string): boolean =>
  ANYWHERE.some(suffix => path.endsWith(suffix));

const ANYWHERE = [
  '.CHECKSUM',    // Commonly found as a sidecar to every file in S3 archives
  'index.html',   // Commonly found in html archives and some other indexes
  '.csv',         // Found as leftovers before compression in a few venues
  '/',            // A directory marker: S3 lists a zero-byte key for the folder itself
];

/**
 * Turn a path that has been read into the pattern that would rebuild it.
 *
 * **Written from the path rather than by hand.** A venue publishes one shape per
 * dataset and a reader has already found the two things that vary in it — the
 * instrument and the date — so the pattern is the path with those put back as
 * slots. Hand-writing one template per dataset would be the same knowledge
 * written twice, free to disagree with the expression that read it.
 *
 * Every occurrence is replaced, because a venue that names the instrument twice
 * in a path names it twice in the pattern too — binance's
 * `…/klines/BTCUSDT/1h/BTCUSDT-1h-2026-08.zip` is exactly that.
 *
 * The stamp is matched in the forms venues actually use, **longest first**, so
 * that `2026080312` is never read as `20260803` with a stray `12` after it, nor
 * `2026-08-03` as `2026-08` with a stray `-03`.
 */
export const patternise = (path: string, urlSymbol: string, date: string): string => {
  const slotted = urlSymbol ? path.replaceAll(urlSymbol, '{SYMBOL}') : path;

  let out = slotted;

  for (const [was, slot] of forms(date)) out = out.replaceAll(was, slot);

  return out;
};

/**
 * Every way a stamp of this grain is written, coarsening as it goes.
 *
 * A path may name the same instant more than once and at more than one width —
 * gate files an hourly book under its month — so all of them are offered, finest
 * first, and each is simply absent from paths that do not use it.
 */
const forms = (date: string): [string, string][] => {
  const year   = date.slice(0, 4);
  const month  = date.slice(4, 6);
  const day    = date.slice(6, 8);
  const hour   = date.slice(8, 10);
  const minute = date.slice(10, 12);

  const all: [string, string][] = [];

  if (minute) all.push([`${year}${month}${day}${hour}${minute}`, '{YYYY}{MM}{DD}{HH}{MI}']);

  if (hour) all.push([`${year}${month}${day}${hour}`, '{YYYY}{MM}{DD}{HH}']);

  if (day)
    all.push([`${year}-${month}-${day}`, '{YYYY}-{MM}-{DD}'],
      [`${year}${month}${day}`, '{YYYY}{MM}{DD}']);

  all.push([`${year}-${month}`, '{YYYY}-{MM}'], [`${year}${month}`, '{YYYY}{MM}']);

  return all;
};

/**
 * What an adapter's `inspectUrl` ends with: the path it just took apart, stated
 * as the series it belongs to.
 *
 * **Venue-agnostic because only the taking-apart is a venue's business.** What
 * arrives here is already canonical — the adapter has turned `futures_usdt` into
 * `perp` and `candlesticks_1m` into `klines` at `1m` — and already carries both
 * names for the instrument. Nothing venue-specific is left to decide.
 */
export const asSeries = (path: string, of: Reading): Inspection => {
  /**
   * **A match that left a hole is not a match.** An expression with alternatives
   * can succeed while a branch that names one of these leaves it undefined, and
   * a row built from that is a series named after nothing.
   */
  if (! of.dataset || ! of.symbol || ! of.date) return { of: 'unknown', date: null };

  const at = of.date.replaceAll('-', '');

  /**
   * **The pattern is built from the archive's spelling, the row is keyed by the
   * venue's own.** They are the same string for every venue here, and where one
   * ever decorates its keys the decoration is a constant of the shape — which
   * `patternise` writes into the template, so a URL is rebuilt from the pattern
   * and the venue's own name and nothing has to reproduce a rule.
   *
   * **Recorded only where it genuinely differs**, which means a transformation
   * inside the name that no pattern can express. Writing a copy of the symbol
   * for every series was half a million strings held in memory to say nothing.
   */
  const urlSymbol = of.urlSymbol ?? of.symbol;

  return {
    of:    'series',
    date:  at,
    found: {
      market:  of.market,
      dataset: of.dataset,
      ...(of.variant === undefined ? {} : { variant: of.variant }),
      symbol:  of.symbol,
      ...(urlSymbol === of.symbol ? {} : { urlSymbol }),
      pattern: patternise(path, urlSymbol, at),
    },
  };
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_relative   = relative;
export const _test_excluded   = excludedAnywhere;
export const _test_patternise = patternise;
