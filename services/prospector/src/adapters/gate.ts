import { asSeries } from '../paths';
import { BUCKET, canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { gateInstruments } from './gate/instruments';
import { gateMisfiled, gateWrongTree } from './gate/misfiled';
import { declare } from './declare';

/**
 * Gate's archive, listed at the bucket behind its CDN — the CDN's own listing
 * ignores what it is asked. The venue is described in `docs/venues/GATE.md`.
 */
export const gate: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(gate),

  name:    'gate',
  scanner: s3,
  probes:  false,

  /** No limit was found on the bucket — measured in `docs/venues/GATE.md`. */
  pacing:  { perSecond: 2000, concurrency: 500 },

  /**
   * The trees gate still publishes, and in them only keys at the depth their
   * tree keeps them; what is refused and why is in `docs/venues/GATE.md`.
   */
  accepts: (path) => {
    const [tree, next = '', , stray] = path.split('/');

    if (! TREES.has(tree ?? '')) return false;

    /** An empty `next` is the tree itself, which descent asks about first. */
    if (next !== '' && /^\d{6}$/.test(next) !== SNAPSHOTS.has(tree ?? '')) return false;

    if (gateMisfiled(path) || gateWrongTree(path)) return false;

    return stray !== STRAY;
  },

  /** What this venue lists today — its only discovery. */
  instruments: gateInstruments,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /** The period a file belongs to: an hourly book is dated by its day and a snapshot by its month. */
  dateOf: (path) => {
    const slice = /\/(\d{6})\/slice_(?:index|options_ticker)_\d{10}$/.exec(path);

    if (slice) return slice[1]!;

    const stamped = /-(\d{6}|\d{8}|\d{10})\.(?:csv\.)?gz$/.exec(path);

    if (! stamped) return null;

    /** Ten digits is an hour, and the hour is the part — the day is the period. */
    return stamped[1]!.slice(0, stamped[1]!.length === 10 ? 8 : stamped[1]!.length);
  },

  /**
   * A period is published whole or not at all, so its first part is asked
   * alone and the rest follow only if it is there — except on a series with no
   * file yet, whose first day starts mid-day.
   */
  expandParts: ({ series, date, lastPartFound, nextPart }) => {
    const every = partsOf(series.pattern, date);

    if (every.length === 0) return null;

    /** Nothing known of this series yet, so the period is asked about whole. */
    if (series.first === null) return { parts: every };

    if (lastPartFound === null) return { parts: every[0]!, next: THE_REST };

    return lastPartFound && nextPart === THE_REST ? { parts: every.slice(1) } : null;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────


/**
 * Read `<market>/<dataset>/<YYYYMM>/<SYMBOL>-<stamp>.csv.gz`, the stamp's length
 * being its grain, or a snapshot `<tree>/<YYYYMM>/slice_<name>_<epoch>`.
 */
const inspect = (path: string): Inspection => {
  const snapshot = GATE_SLICE.exec(path);

  if (snapshot) {
    const { tree, month, name, epoch } = snapshot.groups!;

    if (! STEPS[tree!]) return { of: 'unknown', date: null };

    const meaning = MEANINGS[name!];

    if (! meaning) return { of: 'unknown', date: null };

    return {
      of: 'series', date: month!, part: epoch!,
      found: {
        market:  MARKET_OF[tree!] ?? tree!,
        dataset: meaning.dataset,
        ...(meaning.variant ? { variant: meaning.variant } : {}),

        /** A slice holds every instrument, so it is the market's bundle. */
        symbol:  BUCKET,

        /** The epoch is the part, and the month the period. */
        pattern: `${tree}/{YYYY}{MM}/slice_${name}_{PART}`,
      },
    };
  }

  const found = GATE.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { market, dataset, symbol, date } = found.groups!;

  const canonical = canonicalise(market!, dataset!);

  if (! canonical) return { of: 'unknown', date: null };

  /** Ten digits is an hour: the day is the period and the hour its part. */
  const part = date!.length === 10 ? date!.slice(8, 10) : '';

  /** Gate spells an instrument one way everywhere, so there is no second name to carry. */
  return asSeries(path, { ...canonical, symbol: symbol!,
    date: part ? date!.slice(0, 8) : date!, ...(part ? { part } : {}) });
};

/**
 * Gate's words for a market, in the catalog's: both futures trees are perpetuals,
 * and `delivery_usdt` expires.
 */
const MARKET_OF: Record<string, string> = {
  spot:           'spot',
  spot_index:     'spot',
  futures_usdt:   'perp',
  futures_btc:    'perp',
  delivery_usdt:  'future',
  options_ticker: 'option',
  tradfi:         'tradfi',
};

/** Gate's words for a dataset, in the catalog's. Candlesticks are a family: see `canonicalise`. */
const MEANINGS: Record<string, { dataset: string; variant?: string }> = {
  deals:            { dataset: 'trades' },
  trades:           { dataset: 'trades' },

  /** What was charged at the end of an interval, and the running estimate during one. */
  funding_applies:  { dataset: 'funding', variant: 'realised' },
  funding_updates:  { dataset: 'funding', variant: 'predicted' },

  /** Ticks, where every other venue's mark price is bars. */
  mark_prices:      { dataset: 'markPrice', variant: 'ticks' },

  /** A stream of changes at whatever depth the book has, and whole books of twenty levels. */
  orderbooks:       { dataset: 'books', variant: 'incremental,full' },
  orderbooks_slice: { dataset: 'books', variant: 'snapshot,20' },

  /** An hourly slice of every spot pair's index price at that instant. */
  index:            { dataset: 'indexPrice', variant: 'ticks' },

  /** Every live option's price, implied volatility and greeks, once a minute. */
  options_ticker:   { dataset: 'optionTicker', variant: 'ticks' },
};

/** Gate spells the bar length into the dataset name: `candlesticks_5m`. */
const CANDLES = /^candlesticks_([0-9]+[a-z]+)$/;

const canonicalise = (
  market:  string,
  dataset: string,
): { market: string; dataset: string; variant?: string } | null => {
  const canonical = MARKET_OF[market];

  if (! canonical) return null;

  const candles = dataset.match(CANDLES);

  if (candles) {
    const interval = canonicalInterval(candles[1]!);

    return interval ? { market: canonical, dataset: 'klines', variant: interval } : null;
  }

  const meaning = MEANINGS[dataset];

  return meaning ? { market: canonical, ...meaning } : null;
};

const GATE = new RegExp(
  '^(?<market>[a-z_0-9]+)/(?<dataset>[a-z_0-9]+)'
  + '/\\d{6}/(?<symbol>[^/]+)-(?<date>\\d{10}|\\d{8}|\\d{6})\\.(?:csv\\.)?gz$');

/** `spot_index/202312/slice_index_1702857600` — an instant, with no extension. */
const GATE_SLICE = new RegExp(
  '^(?<tree>[a-z_]+)/(?<month>\\d{6})/slice_(?<name>[a-z_]+)_(?<epoch>\\d{10})$');

/** Every part of one period, in order: a day's twenty-four hours, or a month's instants. */
const partsOf = (pattern: string, date: string): string[] => {
  const slice = /\/slice_([a-z_]+)_\{PART\}$/.exec(pattern);

  if (! slice) return HOURS;

  const step = STEPS[slice[1] === 'index' ? 'spot_index' : 'options_ticker'];

  if (! step) return [];

  const from = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, 1) / 1000;
  const upto = Date.UTC(+date.slice(0, 4), +date.slice(4, 6), 1) / 1000;
  const out: string[] = [];

  for (let at = from; at < upto; at += step) out.push(String(at));

  return out;
};

/** Asked for after the opening part: all the rest of the period. Not a part's name. */
const THE_REST = '*';

/** A day's parts, which are the same twenty-four for every day there has ever been. */
const HOURS = Array.from({ length: 24 }, (_, at) => String(at).padStart(2, '0'));

/** How often each snapshot tree publishes, in seconds. */
const STEPS: Record<string, number> = {
  spot_index:     3_600,
  options_ticker:    60,
};


/** The trees worth surveying. Anything not named here is refused at descent. */
const TREES = new Set([
  'spot', 'futures_usdt', 'futures_btc', 'tradfi',
  'delivery_usdt', 'spot_index', 'options_ticker',
]);

/** The trees that are a dataset in themselves, and so carry a month where the others carry a dataset. */
const SNAPSHOTS = new Set(['spot_index', 'options_ticker']);

/**
 * A directory of spot deals filed inside one month of daily candlesticks:
 * `spot/candlesticks_1d/201802/s3deals/`.
 */
const STRAY = 's3deals';
