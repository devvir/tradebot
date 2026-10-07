import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { dashed } from './htx/symbols';
import { htxInstruments } from './htx/instruments';
import { declare } from './declare';

/**
 * HTX's archive: two trees in one bucket, listed at the bucket and not at the
 * CDN in front of it. The venue is described in `docs/venues/HTX.md`.
 */
export const htx: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(htx),

  name:    'htx',
  scanner: s3,

  /**
   * Not archive: the browsing UI, a scratch directory, each dataset's
   * `remark.txt`, and `data/` from the day the other tree took over.
   */
  accepts: (path) =>
    ! /^(assets|test)\//.test(path)
    && ! /(^|\/)remark\.txt$/.test(path)
    && ! supersededDuplicate(path),

  /** What htx lists today — see `htx/instruments.ts`. */
  instruments: htxInstruments,

  /** No limit was found on the bucket — measured in `docs/venues/HTX.md`. */
  pacing:  { perSecond: 2000, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  dateOf: (path) => dateIn(path),
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The day `historical_data/` took over: `data/` is refused from here on, so the
 * months both wrote are catalogued once.
 */
const MIGRATED = '20260201';

const supersededDuplicate = (path: string): boolean => {
  if (! path.startsWith('data/')) return false;

  const at = dateIn(path);

  return at !== null && at >= MIGRATED;
};

/**
 * The date a path names. Declared apart from the adapter, which is still being
 * built when `accepts` needs it.
 */
const dateIn = (path: string): string | null => {
  const m = /(\d{4})-(\d{2})-(\d{2})\.(?:zip|tar\.gz)$/.exec(path);

  return m ? `${m[1]}${m[2]}${m[3]}` : null;
};


/**
 * Read a path of either tree:
 * `data/<dataset>/<market>/daily/<SYMBOL>/[<interval>/]…` or
 * `historical_data/<market>/daily/<dataset>/[<level>/]<SYMBOL>/[<interval>/]…`.
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
 * The instrument a key names. The offered tree's `-PERP` belongs to the
 * pattern and is dropped; the old tree's joined name is dashed, with its own
 * spelling kept beside it.
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

/** The instrument without `-PERP`, which is the pattern's and not the name's. */
const instrumentOf = (symbol: string): string => symbol.replace(PERPETUAL, '');

/**
 * Htx's words for a market, in the catalog's, where the word alone settles it —
 * see `marketOf` for the rest.
 */
const MARKET_OF: Record<string, string> = {
  spot:   'spot',
  future: 'future',
  option: 'option',
};

/**
 * `futures`, `linear-swap` and `swap` hold perpetuals and dated contracts alike,
 * so the symbol says which.
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

  /** Books: a snapshot and then updates, with the depth a level of the path. */
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
      ? { market: canonical, dataset: 'books', variant: `incremental,${depth}` }
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

/** The offered tree: market first, with a level segment where the dataset has one. */
const HTX_OFFERED = new RegExp(
  '^(?:historical_data/)?(?<market>spot|futures)/(?:daily|monthly)/(?<dataset>[a-z-]+)'
  + '(?:/(?<level>(?:lv)?[0-9]+(?:lv)?))?/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');
