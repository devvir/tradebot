import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { dashed } from './htx/symbols';
import { htxInstruments } from './htx/instruments';
import { declare } from './declare';

/**
 * HTX publishes a standard S3 listing, and keeps **two archives** in the same
 * bucket — differing in what is promised, not only in depth:
 *
 * - `historical_data/<market>/daily/<dataset>/<SYMBOL>/…` — what HTX announces
 *   and offers. Starts `2026-02-01` and written daily since, dashed symbols
 *   (`BTC-USDT`), markets `spot` and `futures`.
 * - `data/<dataset>/<market>/daily/<SYMBOL>/…` — reachable but never announced,
 *   so promised to nobody. Six years deep, stopped `2026-08-04`, undashed spot
 *   symbols (`BTCUSDT`) and dashed elsewhere except a dated `future`, which is
 *   `BTC260206` with no quote currency at all. Markets `spot`, `future`, `swap`,
 *   `linear-swap` and `option`.
 *
 * **Neither is a rolling window** — both still hold their first day, so a floor
 * here is a launch date as it is at every other venue.
 *
 * Surveying from the bucket root is what makes the second visible at all;
 * starting at `historical_data/` hid it entirely. Nothing is stripped, so each
 * path says which tree it came from and a URL is `base` + `/` + `path`.
 *
 * Books ship as `.tar.gz` where everything else is `.zip`, so the date pattern
 * accepts both. One granularity — days — so nothing to tag.
 *
 * **Addressed at the bucket, not at `www.htx.com/data` which fronts it.** The
 * domain is an Akamai edge and enforces its own limit, far below what the
 * bucket behind it will serve: half a dozen listing requests earned a
 * `403 AkamaiGHost` on every prefix at once, and probes that were neither
 * answered nor refused — sockets accepted and left silent until each died on
 * its own deadline, where the bucket answers a plain `404`. The bucket names
 * itself in every listing it serves (`<Name>huobi-service-data</Name>`), and
 * both trees are there in full.
 *
 * The edge's refusals are also unreadable: a `403` with no `x-amz-error-code`
 * is indistinguishable from a real block, so absence and rejection arrived as
 * the same answer. Against S3 the two are separate again.
 */
export const htx: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(htx),

  name:    'htx',
  scanner: s3,
  list:    'https://huobi-service-data.s3.amazonaws.com',

  /**
   * The bucket also serves the browsing UI, a scratch directory, and a page of
   * documentation at the root of each dataset.
   *
   * **`remark.txt` is the field descriptions**, one per dataset and market
   * under `data/` — thirteen of them, saying what each column means, which the
   * newer tree shows in a dialog on its portal instead. It is documentation and
   * carries no date, so nothing would place it in a series; refusing it by name
   * keeps it out of the unreadable list, where it would sit for ever looking
   * like a shape nobody has parsed yet.
   */
  accepts: (path) =>
    ! /^(assets|test)\//.test(path)
    && ! /(^|\/)remark\.txt$/.test(path)
    && ! supersededDuplicate(path),

  /** What htx lists today — see `htx/instruments.ts`. */
  instruments: htxInstruments,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  dateOf: (path) => dateIn(path),
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The day `historical_data/` took over, and the cut between the two trees.
 *
 * Both were written from here until 2026-08-04 — the same trading twice, in two
 * schemas — so `accepts` refuses `data/` from this date on and the overlap is
 * catalogued once. Below it, `data/` is the only source there has ever been.
 */
const MIGRATED = '20260201';

const supersededDuplicate = (path: string): boolean => {
  if (! path.startsWith('data/')) return false;

  const at = dateIn(path);

  return at !== null && at >= MIGRATED;
};

/**
 * The date a path names, read the same way the adapter reads it.
 *
 * Declared here rather than reaching for `htx.dateOf`, because the adapter is
 * still being built when `accepts` is written into it.
 */
const dateIn = (path: string): string | null => {
  const m = /(\d{4})-(\d{2})-(\d{2})\.(?:zip|tar\.gz)$/.exec(path);

  return m ? `${m[1]}${m[2]}${m[3]}` : null;
};


/**
 * HTX, which publishes **two separate trees with the segments in different
 * orders** — documented in `docs/venues/HTX.md`, and the reason one expression
 * cannot cover it:
 *
 * ```
 * data/<dataset>/<market>/daily/<SYMBOL>/[<interval>/]…
 * historical_data/<market>/daily/<dataset>/[<level>/]<SYMBOL>/[<interval>/]…
 * ```
 *
 * The first is the tree htx does not announce and which reaches back six years;
 * the second is the offered one. They carry the same data under different
 * arrangements, so a series in one is not a series in the other — which is
 * exactly what two patterns mean.
 */
const inspect = (path: string): Inspection => {
  const quiet = HTX_DATA.exec(path);

  if (quiet) {
    const { market, dataset, interval, level, symbol, date } = quiet.groups!;

    return read(path, market!, dataset!, interval, level, symbol!, date!, false);
  }

  const offered = HTX_OFFERED.exec(path);

  if (offered) {
    const { market, dataset, level, interval, symbol, date } = offered.groups!;

    return read(path, market!, dataset!, interval, level, symbol!, date!, true);
  }

  return { of: 'unknown', date: null };
};

/**
 * **Which tree a key came from decides how its instrument is named**, and the
 * two trees are wrong about it in opposite directions.
 *
 * The offered one decorates a name with `-PERP`, which is a constant of the
 * shape and belongs in the pattern — so the symbol loses it and no `urlSymbol`
 * is recorded, leaving `patternise` to write the suffix into the template.
 *
 * The old one joins names that the rest of htx separates, which no pattern can
 * express because the change is *inside* the name. So the symbol takes the
 * dashed form and the archive's own spelling is recorded beside it, which is
 * exactly what `urlSymbol` is for.
 */
const read = (
  path:     string,
  market:   string,
  dataset:  string,
  interval: string | undefined,
  level:    string | undefined,
  symbol:   string,
  date:     string,
  offered:  boolean,
): Inspection => {
  const canonical = canonicalise(market, dataset, interval, level, symbol);

  if (! canonical) return { of: 'unknown', date: null };

  if (offered)
    return asSeries(path, { ...canonical, symbol: instrumentOf(symbol), date });

  return asSeries(path,
    { ...canonical, symbol: dashed(market, symbol), urlSymbol: symbol, date });
};

/**
 * The instrument, as against the archive's spelling of it.
 *
 * **`-PERP` is a constant of the shape rather than part of the name.** Every
 * series of the offered tree's perpetual patterns carries it and none of its
 * dated ones do, so it belongs in the pattern —
 * `futures/daily/trades/{SYMBOL}-PERP/{SYMBOL}-PERP-trades-…` — which is where
 * `patternise` writes it and `keyFor` reads it back.
 *
 * **Keeping it on the series would spell one contract two ways.** `data/` calls
 * the same instrument `BTC-USDT`, and a suffix carried on one branch and not the
 * other would put the two trees' rows under different names for no reason the
 * venue recognises. The market already says which kind of contract it is.
 */
const instrumentOf = (symbol: string): string => symbol.replace(PERPETUAL, '');

/**
 * Htx's own words for a market, in the catalog's — the ones that map straight
 * through, because the word alone settles what the instrument is.
 *
 * `future` really is dated throughout, and `option` and `spot` cannot be
 * anything else. The two words missing from here are the ones that name how a
 * contract settles rather than what kind it is — see `marketOf`.
 */
const MARKET_OF: Record<string, string> = {
  spot:   'spot',
  future: 'future',
  option: 'option',
};

/**
 * **Three of htx's words group perpetuals with dated contracts**, so for those
 * the market is a property of the instrument and only the symbol can answer.
 * Each tree spells the same question differently:
 *
 * - `futures` is the offered tree's single word for everything it carries, and
 *   its perpetuals name themselves — `BTC-USD-PERP` beside `BTC-USD-260206`.
 * - `linear-swap` is the unannounced tree's word for *USDT-margined*, which
 *   covers both kinds — `BTC-USDT` beside `BTC-USDT-230407` in one directory.
 *   Its dated contracts carry the expiry instead, since nothing there is
 *   suffixed.
 *
 * `swap` is the coin-margined half of the same idea and has never carried a
 * dated contract — those live under `future` — but it is asked the same
 * question, because a word that groups by settlement may group by it again.
 *
 * **Measured before it was relied on**: of the symbols under `linear-swap`, every
 * one ending in six digits is dash-separated and parses as a `YYMMDD` expiry, and
 * no perpetual there ends in digits at all. `option` is deliberately not asked —
 * its symbols end in a strike, and a six-figure one would read as a date.
 */
const PERPETUAL = /-PERP$/;
const DATED     = /-\d{6}$/;

const marketOf = (market: string, symbol: string): string | undefined => {
  if (market === 'futures') return PERPETUAL.test(symbol) ? 'perp' : 'future';

  if (market === 'swap' || market === 'linear-swap')
    return DATED.test(symbol) ? 'future' : 'perp';

  return MARKET_OF[market];
};

/** Htx's own words for a dataset, in the catalog's. */
const MEANINGS: Record<string, { dataset: string; variant?: string; binned?: true; book?: true }> = {
  trades:              { dataset: 'trades' },
  klines:              { dataset: 'klines',     binned: true },
  'index-klines':      { dataset: 'indexPrice', binned: true },
  'mark-klines':       { dataset: 'markPrice',  binned: true },
  'mark-price-klines': { dataset: 'markPrice',  binned: true },
  'funding-rates':     { dataset: 'funding', variant: 'realised' },

  /**
   * **Htx serves okx's book format**, verified on a real file: one `snapshot`
   * line then `update` lines, JSON per row. The depth is a path level rather
   * than part of the name — 400 for spot, 150 for futures.
   */
  orderbook:           { dataset: 'books', book: true },
};

const canonicalise = (
  market:   string,
  dataset:  string,
  interval: string | undefined,
  level:    string | undefined,
  symbol:   string,
): { market: string; dataset: string; variant?: string } | null => {
  const canonical = marketOf(market, symbol);

  const meaning = MEANINGS[dataset];

  if (! canonical || ! meaning) return null;

  if (meaning.book) {
    const depth = level?.match(/[0-9]+/)?.[0];

    return depth
      ? { market: canonical, dataset: 'books', variant: `${depth},incremental` }
      : null;
  }

  if (! meaning.binned) {
    return { market: canonical, dataset: meaning.dataset,
      ...(meaning.variant ? { variant: meaning.variant } : {}) };
  }

  /** A bar without its length is not data, so a missing interval is a refusal. */
  const bar = interval ? canonicalInterval(interval) : null;

  return bar ? { market: canonical, dataset: meaning.dataset, variant: bar } : null;
};

/** The unannounced tree: dataset first. */
const HTX_DATA = new RegExp(
  '^data/(?<dataset>[a-z-]+)/(?<market>[a-z-]+)/(?:daily|monthly)'
  + '(?:/(?<level>[a-z0-9]+))?/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');

/**
 * The offered tree: market first, and with a level segment where the dataset has
 * one — `spot/daily/orderbook/lv400/<SYMBOL>/…`.
 */
const HTX_OFFERED = new RegExp(
  '^(?:historical_data/)?(?<market>spot|futures)/(?:daily|monthly)/(?<dataset>[a-z-]+)'
  + '(?:/(?<level>(?:lv)?[0-9]+(?:lv)?))?/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');
