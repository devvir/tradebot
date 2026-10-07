import { asSeries } from '../paths';
import { canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { kucoinInstruments } from './kucoin/instruments';
import { declare } from './declare';

/**
 * KuCoin's archive: a standard listing on the host that serves the files, every
 * file a day. The venue is described in `docs/venues/KUCOIN.md`.
 */
export const kucoin: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(kucoin),

  name:    'kucoin',
  scanner: s3,

  /** No limit was found — measured in `docs/venues/KUCOIN.md`. */
  pacing:  { perSecond: 5000, concurrency: 500 },

  /** Days behind today a probing pass stops asking: the venue's measured publishing delay, and a day more. */
  probingLag: 3,

  /** What this venue lists today — its only discovery. */
  instruments: kucoinInstruments,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /** How the archive spells an instrument under one dataset: `named`, asked the other way. */
  urlSymbolFor: (of) => spelling(of.market, of.dataset, of.symbol),

  dateOf: (path) => {
    const m = /(\d{4})-(\d{2})-(\d{2})\.zip$/.exec(path);

    return m ? `${m[1]}${m[2]}${m[3]}` : null;
  },

  /**
   * Futures klines at `1d` are published without their volume, and are refused —
   * see `docs/venues/KUCOIN.md`.
   */
  accepts: (path) => ! /^futures\/daily\/klines\/[^/]+\/1d(?:\/|$)/.test(path),
});

// ── Internals ─────────────────────────────────────────────────────────────────

/** Read `<market>/<grain>/[depth/]<dataset>/<SYMBOL>/[<interval>/]<file>`. */
const inspect = (path: string): Inspection => {
  const found = KUCOIN.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { market, dataset, interval, symbol, date } = found.groups!;

  const canonical = canonicalise(market!, dataset!, interval);

  if (! canonical) return { of: 'unknown', date: null };

  /** Keyed by the venue's own name, with the archive's spelling beside it where the two differ. */
  return asSeries(path, { ...canonical, ...named(canonical.market, symbol!), date: date! });
};

/**
 * The instrument a path names, as kucoin's API names it: spot gets its dash
 * back outside books, and a `BTC` future is an `XBT` one.
 */
const named = (market: string, path: string): { symbol: string; urlSymbol?: string } => {
  const symbol = market === 'perp' && path.startsWith('BTC') ? `XBT${path.slice(3)}`
    : market === 'spot' && ! path.includes('-') ? (dashed(path) ?? path)
      : path;

  return symbol === path ? { symbol } : { symbol, urlSymbol: path };
};

/** Where the dash goes, from the quote the pair settles in. Null where none is known. */
const dashed = (flat: string): string | null => {
  const quote = QUOTES.find(one => flat.endsWith(one) && flat.length > one.length);

  return quote ? `${flat.slice(0, -quote.length)}-${quote}` : null;
};

/** The quotes a spot pair may end in, longest first so that the split is unambiguous. */
const QUOTES = ['USDT', 'USDC', 'USD1', 'USDG', 'TUSD', 'DOGE', 'BTC', 'ETH', 'KCS', 'EUR',
  'TRX', 'BRL', 'DAI', 'GBP', 'THB', 'TRY']
  .sort((a, b) => b.length - a.length);

/** What a path must say for an instrument as kucoin names it: `named`, inverted. */
const spelling = (market: string, dataset: string, symbol: string): string | undefined => {
  if (market === 'spot') return dataset === 'books' ? undefined : symbol.replaceAll('-', '');

  if (market !== 'perp' || ! symbol.startsWith('XBT')) return undefined;

  /** A dated contract is spelled `BTC` only under books; the perpetuals are everywhere. */
  return DATED.test(symbol) && dataset !== 'books' ? undefined : `BTC${symbol.slice(3)}`;
};

/** A quarterly contract: the month code and a two-digit year — `XBTMU26`. */
const DATED = /^XBTM[HMUZ]\d{2}$/;

/**
 * KuCoin's words for a market, in the catalog's: `futures` is its perpetuals, with
 * a few quarterly contracts among them.
 */
const MARKET_OF: Record<string, string> = { spot: 'spot', futures: 'perp' };

/** KuCoin's own words for a dataset, in the catalog's. */
const MEANINGS: Record<string, { dataset: string; variant?: string; binned?: true }> = {
  trades:       { dataset: 'trades' },
  klines:       { dataset: 'klines',     binned: true },
  index:        { dataset: 'indexPrice', binned: true },
  mark:         { dataset: 'markPrice',  binned: true },
  fundingRates: { dataset: 'funding', variant: 'realised' },
};

/** The books name their depth in the dataset: `orderbooklv50`. */
const BOOK = /^orderbooklv([0-9]+)$/;

const canonicalise = (
  market:   string,
  dataset:  string,
  interval: string | undefined,
): { market: string; dataset: string; variant?: string } | null => {
  const canonical = MARKET_OF[market];

  if (! canonical) return null;

  const book = dataset.match(BOOK);

  if (book) return { market: canonical, dataset: 'books', variant: `snapshot,${book[1]}` };

  const meaning = MEANINGS[dataset];

  if (! meaning) return null;

  if (! meaning.binned) {
    return { market: canonical, dataset: meaning.dataset,
      ...(meaning.variant ? { variant: meaning.variant } : {}) };
  }

  const bar = interval ? canonicalInterval(interval) : null;

  return bar ? { market: canonical, dataset: meaning.dataset, variant: bar } : null;
};

const KUCOIN = new RegExp(
  '^(?<market>spot|futures)/(?:daily|monthly)(?:/depth)?/(?<dataset>[A-Za-z0-9]+)'
  + '/(?<symbol>[^/]+)(?:/(?<interval>[^/]+))?'
  + '/[^/]*(?<date>\\d{4}-\\d{2}(?:-\\d{2})?)\\.[a-z.]+$');
