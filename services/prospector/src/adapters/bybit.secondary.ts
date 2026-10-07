import { asSeries } from '../paths';
import { html } from '../scanners/html';
import { listing, surveying } from '../context';
import type { Adapter, Inspection } from '../types';
import { bybitInstruments } from './bybit/instruments';
import { declare } from './declare';

/**
 * Bybit's order books, which live on a different server from everything else it
 * publishes.
 *
 * A separate adapter rather than a branch inside the primary one, because
 * nothing about it is shared: a different address, a different tree, browsable
 * indexes instead of a bucket listing, and its own limiter. Treating it as the
 * same venue would make a stand-down on one host stop the other and let each
 * spend the other's budget.
 *
 * ```
 * orderbook/{linear,inverse}/<SYMBOL>/<yyyy-mm-dd>_<SYMBOL>_ob<depth>.data.zip
 * ```
 *
 * The indexes are generated rather than stale — `orderbook/linear/` was
 * rewritten the morning it was checked — so what they list is current even
 * though each page is a stored object served through a CDN.
 *
 * **The origin bucket is not findable, and looking again is a waste of time.**
 * A missing key returns S3's own 404 through the edge, but it carries only
 * `Code`, `Key`, `RequestId` and an opaque `HostId` — there is no `BucketName`,
 * so the leak that gave up okx's bucket has no equivalent here. Nor does the
 * sibling convention hold: `public.bybit.com` is literally a bucket name, while
 * `quote-saver.bycsi.com`, `quote-saver`, `bycsi.com` and `bybit-quote-saver`
 * all answer `NoSuchBucket` from `s3.amazonaws.com`, where a bucket in another
 * region would answer `PermanentRedirect` and name itself. Those names exist
 * nowhere. The cost of staying on the CDN is a HEAD per file, which is what
 * `probes` is for.
 */
export const bybitSecondary: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(bybitSecondary),

  name:    'bybit',
  host:    'secondary',
  scanner: html,

  /**
   * This host's index names files and states nothing else — no size, no
   * last-modified, no checksum — so every row it produces arrives unsettled.
   */
  probes:  true,

  /**
   * **A `404` here contradicts evidence, so it is worth confirming hard — but
   * only while an index is what put the key on the list.**
   *
   * On a walk this host's index has already said the file is there, so a
   * `404` against it is this CDN having a bad few minutes far more often than a
   * withdrawal. A hundred attempts costs a hundred requests on a tree of a few
   * thousand directories, and buys back a file the index promised.
   *
   * On an update nothing promised anything: the key was built from a pattern and
   * a date, and absence is the ordinary answer to a guess. So the rule asks
   * which pass it is in rather than treating the two alike.
   */
  ruleOnFailure: (_row, status, _headers, tries) =>
    (status === 404 && surveying(bybitSecondary) === 'walk' && tries < INDEXED_TRIES
      ? 'keep'
      : null),

  /**
   * **No limit found.** Measured 2026-09-30 with HEAD probes: 5,496/s from the
   * remote on keys the edge had cached, and 3,870/s from here on missing ones,
   * which go to the origin (~220 ms), without a single throttling answer. More
   * than 600 at once would mostly wait on the machine-wide ceiling.
   */
  pacing:  { perSecond: 5000, concurrency: 500 },

  /**
   * Walking, every update — see `docs/services/PROSPECTOR.md`, *How each venue updates*.
   */

  /**
   * How far behind today this venue is worth asking about.
   *
   * **Measured from the venue's own `Last-Modified`**, 2026-09-25 over the files
   * of 2026-09-15 to 21: the same schedule its sibling publishes on, measured together — a frontier that differed between the two would ask one instrument about different days.
   *
   * **Every venue publishes more than a day after its period begins**, so a pass
   * running in the small hours finds nothing for yesterday whatever the catalog's
   * newest file suggests — a snapshot taken in the afternoon says only that the
   * file had arrived by the afternoon.
   *
   * **A day further back again**, because a publishing hour that drifts later
   * would put the frontier in front of the archive. Asking early costs a probe
   * per series per night, every night, for a period that cannot exist yet; asking
   * late costs the catalog's edge a day, and loses nothing — the frontier
   * advances daily and the patience window covers what it has not reached.
   */
  probingLag: 3,

  /** What bybit lists today — see `bybit/instruments.ts`. */
  instruments: async (db) => bybitInstruments(db, 'secondary'),

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * The date leads the filename here, where every other bybit tree buries it,
   * so the venue's first-date-wins rule covers this unchanged.
   */
  dateOf: (path) => {
    const day = /(\d{4})-(\d{2})-(\d{2})/.exec(path.slice(path.lastIndexOf('/') + 1));

    return day ? `${day[1]}${day[2]}${day[3]}` : null;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The order-book host, which shares nothing with the primary's four shapes:
 * `linear/BTCUSDT/2025-08-21_BTCUSDT_ob200.data.zip`, with `inverse/` beside it
 * and no third market. The key root is `orderbook/`, so the catalog sees it
 * stripped, and this is the only bybit tree that leads with the date.
 *
 * **An instrument name is letters, digits, dashes and underscores**, so its own
 * punctuation cannot bound it. The date leading the filename and the `_ob<depth>`
 * closing it are what do — `WC_ARG_ALG_USDT-17JUN26` being the case that says so.
 *
 * **The depth is part of the shape, not of the date.** Bybit moved from 500
 * levels to 200, so a symbol has files of both — different files, different
 * series, and the pattern keeps whichever it was read from literal, exactly as
 * an interval stays literal elsewhere.
 */
const inspect = (path: string): Inspection => {
  const found = BOOKS.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { symbol, depth, date } = found.groups!;

  /**
   * **Both of bybit's book markets are perpetual swaps.** `linear` and `inverse`
   * differ in what settles them, which is a property of the instrument.
   *
   * The depth is the variant, and it is the only thing separating two files of
   * one instrument on one day: bybit moved from 500 levels to 200, so a symbol
   * has both, and they are different series. The stream itself is `snapshot`
   * then `delta`, verified on a real file.
   */
  return asSeries(path, {
    market:  'perp',
    dataset: 'books',
    variant: `${depth},incremental`,
    symbol:  symbol!,
    date:    date!,
  });
};

const BOOKS = new RegExp(
  '^(?<market>linear|inverse)/[^/]+'
  + '/(?<date>\\d{4}-\\d{2}-\\d{2})_(?<symbol>[A-Za-z0-9_-]+)_ob(?<depth>\\d+)\\.data\\.zip$');

/**
 * How often a walked key may answer `404` before it is written off.
 *
 * Large on purpose, and affordable only because of what it applies to: keys an
 * index named, on a host of a few thousand directories. It is not a retry budget
 * — it is how much contradicting an index is worth.
 */
const INDEXED_TRIES = 100;
