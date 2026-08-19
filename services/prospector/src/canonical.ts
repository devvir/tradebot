import type { Grain } from './types';

/**
 * The vocabulary the catalog speaks, and the one thing every adapter needs to
 * translate into it.
 *
 * **A venue's own words stop at its adapter.** Gate keeps perpetuals in
 * `futures_usdt` and `futures_btc`, okx shouts `SWAP`, htx has two spellings of
 * one market from two eras of its archive, and none of that is a fact about a
 * trade or a bar. A consumer asks for `perp` `klines` at `1m` and is answered;
 * that a venue writes `candlesticks_1m` is this service's business.
 *
 * What lives here is only what is genuinely shared: the names themselves, and
 * the rule for reading a bar length. The mapping from one venue's words to these
 * is that venue's, and lives in its adapter.
 */

/**
 * A market as the catalog names it.
 *
 * **Margining is not a market.** Bybit's `linear` and `inverse`, htx's `swap`
 * and `linear-swap`, binance's `futures-um` and `futures-cm` are all perpetual
 * swaps differing in what collateralises them — a property of the instrument,
 * readable from its symbol, and not a reason for a consumer to look in two
 * places for one kind of series.
 *
 * `tradfi` is gate's equities and metals feed. It is not crypto and does not
 * pretend to be one of the others.
 */
export const MARKETS = ['spot', 'perp', 'future', 'option', 'tradfi'] as const;

/**
 * A dataset as the catalog names it — the table, without its variants.
 *
 * Deliberately the vocabulary stocker already reads into the vault: a second set
 * of names for one series would have to be reconciled by every consumer of both.
 *
 * **A venue's name for a rendering is not a dataset.** Binance publishes trades
 * twice, raw and aggregated, and calls the second `aggTrades` — but aggregation
 * is a property of *those trades*, exactly as a book's depth is a property of
 * that book. So it is a variant of `trades`, and a consumer asking for trades
 * finds both renderings rather than having to know one venue's word for one of
 * them.
 */
export const DATASETS = [
  'trades', 'klines', 'markPrice', 'indexPrice',
  'premiumIndex', 'funding', 'borrowing', 'quotes', 'depthBands',
  'openInterest', 'liquidations', 'books', 'volatilityIndex',
  'optionSummary', 'optionTicker',
] as const;

/**
 * How often a shape publishes, as a caller may ask for it.
 *
 * **The vocabulary's answer to one dataset published twice.** A venue that files
 * its trades both monthly and daily offers the same month in two renderings, and
 * a consumer that knows which it wants should be able to say so rather than
 * fetch both and throw one away.
 *
 * `satisfies` rather than a cast, so a name that is not a `Grain` is a compile
 * error here. The type itself stays in `types.ts`, where every type lives.
 */
export const GRAINS = ['monthly', 'daily', 'hourly', 'minutely'] as const satisfies readonly Grain[];

/**
 * The symbol standing for "every instrument of this market at once".
 *
 * **A symbol like any other, rather than an absence.** Okx publishes one file a
 * day carrying every swap it lists, and gate a slice an hour holding every spot
 * index; storing those as an empty symbol made "the bucket" a case every reader
 * had to remember to test for. As a name it filters, sorts and reads like the
 * rest — and asking for it is asking for exactly those files.
 */
export const BUCKET = '@';

/**
 * One spelling for a bar length, whatever the venue called it.
 *
 * Venues disagree — htx writes `60min` where binance writes `1h`, gate says `7d`
 * where binance says `1w`, bybit's MetaTrader feed counts bare minutes — and
 * that disagreement is no more meaningful than their disagreeing about what to
 * call a trade.
 *
 * So a length is measured in seconds and written back out as **the largest whole
 * unit that fits**: seconds under a minute, minutes under an hour, hours under a
 * day, days under a week, then weeks. `7d` and `1w` are one duration and get one
 * name; `90m` stays minutes because an hour does not divide it.
 *
 * Answers `null` where the token names no duration, which is a caller's cue that
 * it has matched something that is not an interval at all.
 */
export const canonicalInterval = (token: string): string | null => {
  const raw = token.trim().toLowerCase();

  if (raw === '') return null;

  /**
   * A calendar month never enters the arithmetic: February and August are the
   * same interval and different durations.
   */
  if (MONTHLY.test(raw)) {
    const count = Number(raw.match(MONTHLY)?.[1] || '1');

    return Number.isInteger(count) && count > 0 ? `${count}mo` : null;
  }

  const seconds = secondsOf(raw);

  if (seconds === null || seconds <= 0) return null;

  for (const [unit, size, ceiling] of UNITS)
    if (seconds < ceiling && seconds % size === 0) return `${seconds / size}${unit}`;

  return seconds % WEEK === 0 ? `${seconds / WEEK}w` : finest(seconds);
};

/** The variants of a dataset, as one string — `500,incremental`, `1m`. */
export const variantOf = (...levels: readonly (string | null | undefined)[]): string =>
  levels.filter((one): one is string => Boolean(one)).join(',');

/**
 * What the levels of each dataset's variant **are**, in the order they are
 * written.
 *
 * **A variant is stored as one string because a path is one string**, but
 * `400,incremental` is two facts about a book and a consumer deciding between
 * depths should not be splitting commas and counting positions to find them. So
 * the catalog names them on the way out — see `levelsOf`.
 *
 * A dataset absent from here has no level below it: `quotes` is quotes.
 */
export const LEVELS: Record<string, readonly string[]> = {
  klines:          ['interval'],
  markPrice:       ['interval'],
  indexPrice:      ['interval'],
  premiumIndex:    ['interval'],
  volatilityIndex: ['interval'],
  optionSummary:   ['interval'],
  optionTicker:    ['interval'],

  /** Depth first, then whether the file is a stream of changes or whole books. */
  books:           ['depth', 'mode'],

  /**
   * `aggregated` where a venue bins them and says so, `default` for the flavour
   * it publishes without qualification.
   *
   * **Most venues publish one flavour and state nothing about it**, and whether
   * those trades are already aggregated is not something the archive says. So
   * the catalog stores nothing there and reports `default` — a word that claims
   * only "this is the one it publishes", never that it is raw.
   */
  trades:          ['aggregation'],

  /** What was charged at the end of an interval, or the estimate as it moved. */
  funding:         ['kind'],
};

/**
 * What a level means when the catalog has nothing stored against it.
 *
 * **Only where the absence is itself meaningful.** A book with no depth recorded
 * is a gap; trades with no aggregation recorded are simply the trades that venue
 * publishes, which is a thing a consumer can ask for by name.
 */
const DEFAULTS: Record<string, string> = { aggregation: 'default' };

/**
 * One dataset's variant, taken apart into the levels it is made of.
 *
 * `books` + `400,incremental` becomes `{ depth: '400', mode: 'incremental' }`,
 * and a dataset with no levels — or a series with no variant — becomes `{}`.
 *
 * **Order is preserved**, because the object is built from `LEVELS` in order and
 * that is the order the variant string is written in. Anything rebuilding the
 * string from this can join the values as they come.
 */
export const levelsOf = (dataset: string, variant: string): Record<string, string> => {
  const names = LEVELS[dataset] ?? [];

  /**
   * **A level with a default is always reported**, even where nothing is stored
   * against it, so a consumer never has to treat "no variant" and "the ordinary
   * one" as two cases. Storing it would be claiming knowledge the archive does
   * not give us; reporting it is only naming what a caller can then ask for.
   */
  if (variant === '')
    return Object.fromEntries(names.filter(name => name in DEFAULTS)
      .map(name => [name, DEFAULTS[name]!]));
  const parts = variant.split(',');
  const found: Record<string, string> = {};

  names.forEach((name, at) => {
    /**
     * **The last name takes whatever is left**, so a venue publishing a level
     * nobody has named yet is reported rather than silently dropped. Under a
     * correct vocabulary this is exactly one part.
     */
    const value = at === names.length - 1 ? parts.slice(at).join(',') : parts[at];

    if (value) found[name] = value;
  });

  return found;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const MINUTE = 60;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;
const WEEK   = 7 * DAY;

/** `1mo`, `1mon`, `1month`, and the bare `mo` a venue writes for a single one. */
const MONTHLY = /^(\d*)\s*(?:mo|mon|month|months)$/;

/** Each unit with the ceiling it applies below; the order is the rule. */
const UNITS: readonly (readonly [string, number, number])[] = [
  ['s', 1,      MINUTE],
  ['m', MINUTE, HOUR],
  ['h', HOUR,   DAY],
  ['d', DAY,    WEEK],
];

/** How every venue in this catalog spells a unit, expanded to seconds. */
const SUFFIXES: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: WEEK, wk: WEEK, week: WEEK, weeks: WEEK,
};

const secondsOf = (raw: string): number | null => {
  const parsed = raw.match(/^(\d+)\s*([a-z]*)$/);

  if (! parsed) return null;

  const count  = Number(parsed[1]);
  const suffix = parsed[2] ?? '';

  if (! Number.isInteger(count)) return null;

  /**
   * Bybit's MetaTrader feed names a bar by its length in minutes and nothing
   * else. Every other venue writes a unit, so an unmarked number is never
   * ambiguous in practice.
   */
  if (suffix === '') return count * MINUTE;

  const size = SUFFIXES[suffix];

  return size === undefined ? null : count * size;
};

/** The finest unit that divides a duration no coarser bracket divides. */
const finest = (seconds: number): string => {
  for (const [unit, size] of [...UNITS].reverse())
    if (seconds % size === 0) return `${seconds / size}${unit}`;

  return `${seconds}s`;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_secondsOf = secondsOf;
