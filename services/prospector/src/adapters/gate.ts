import { asSeries } from '../paths';
import { BUCKET, canonicalInterval } from '../canonical';
import { s3 } from '../scanners/s3';
import { listing } from '../context';
import type { Adapter, Inspection } from '../types';
import { gateInstruments } from './gate/instruments';
import { declare } from './declare';

/**
 * Gate's archive is a standard S3 bucket — `gateio-public-data` — surveyed at
 * its **origin** rather than through the CDN that serves the files.
 *
 * `download.gatedata.org` is CloudFront, and it answers listings while ignoring
 * every query parameter: `?prefix=`, `?marker=` and `?max-keys=` all come back
 * as the same cached first thousand keys of the bucket root, byte for byte. A
 * reply that looks exactly like a working listing and is not one is worse than
 * no listing at all, which is why the address here is the bucket. Asked
 * directly, it honours `prefix`, `delimiter`, `max-keys` and
 * `continuation-token` in the ordinary way.
 *
 * This is why gate was believed to publish no listing and was collected by
 * constructing URLs and probing them: the CDN was answering, so nobody read
 * past it.
 *
 * **Nothing to probe.** Every key arrives with size, ETag and last-modified.
 *
 * Four path shapes, all keyed by a stamp after the last `-`:
 *
 * ```
 * <market>/<dataset>/<yyyymm>/<SYMBOL>-<yyyymm>.csv.gz        a month
 * <market>/<dataset>/<yyyymm>/<SYMBOL>-<yyyymmdd>.csv.gz      a day
 * <market>/<dataset>/<yyyymm>/<SYMBOL>-<yyyymmddHH>.csv.gz    an hour
 * <tree>/<yyyymm>/slice_<name>_<epoch>                        a snapshot
 * ```
 *
 * Which shape a dataset uses is the dataset's own business and is not declared
 * here — spot candlesticks are daily below 30 minutes and monthly above, books
 * are hourly, everything else is monthly. The stamp's length says which, so no
 * dataset needs naming.
 *
 * Two of them are worth pointing at. `orderbooks_slice` is a plain `.gz` where
 * everything else is `.csv.gz`. And `delivery_usdt` carries a second date inside
 * the symbol — `ADA_USDT_20260605-2026060100.csv.gz` is the 2026-06-05 expiry,
 * hour 00 of 2026-06-01 — which is why the stamp is read from the last `-` and
 * not from the first date in the name.
 */
export const gate: Adapter = declare({
  /** The shared listing context — this venue differs by address, not by shape. */
  getContext: async () => listing(gate),

  name:    'gate',
  scanner: s3,
  list:    'https://s3-ap-northeast-1.amazonaws.com/gateio-public-data',
  probes:  false,

  /**
   * **The same figures binance declares, on purpose.**
   *
   * Both venues list from `s3-ap-northeast-1.amazonaws.com` and a limiter is
   * built once per host, from whichever adapter reaches it first — so declaring
   * anything different here would mean the pace depends on which venue's survey
   * started first. Changing one of these without the other is the bug this note
   * exists to prevent.
   *
   * Lowered a second time, after connect timeouts came back on both venues with
   * no refusal of any kind from the host. See the note on binance for what is
   * and is not known about why.
   */
  pacing:  { perSecond: 30, concurrency: 100 },

  /**
   * The seven trees gate still publishes. Everything else in the bucket is dead
   * or is not market data, and a refused prefix is never descended into.
   *
   * Not collected anywhere before this: `delivery_usdt` (dated-futures books,
   * current), `spot_index` and `options_ticker` (venue-wide snapshots, hourly
   * and per minute, both current).
   *
   * What is refused, and why none of it is data a consumer could want:
   *
   * - `v2/` — two months, 202211 and 202212, and nothing since.
   * - `hk/`, `malta/` — separate Gate entities with their own order books, so
   *   their `BTC_USDT` is **not** this venue's. Both stop at 202402, retired in
   *   the same month. If either is ever wanted it is a venue row of its own,
   *   never a prefix of this one, or two unrelated books merge under one symbol
   *   with nothing said.
   * - `future_usdt/` — nine months to 202211, last written 2022-11-24. Note the
   *   singular, beside the live `futures_usdt/`.
   * - `futures_usd/` — five months to 202212, last written 2022-12-01.
   * - `gatepay/` — two spreadsheet templates.
   *
   * **What sits one level below a tree is a month or a dataset, and which one
   * the tree decides.** `spot_index/` and `options_ticker/` are a dataset in
   * themselves and carry the month there; every other tree names a dataset and
   * carries the month a level lower. Either in the other's place is a key
   * somebody filed in the wrong place, and both happen:
   *
   * - 571 keys sit at `spot/201905/`, `futures_usdt/202107/` and
   *   `futures_btc/202107/`, a month where a dataset belongs. Each is
   *   byte-for-byte the size of its canonical twin with a different ETag and an
   *   earlier mtime — the same data under a layout gate abandoned.
   * - 179 sit at `spot_index/slice_index_…`, a file where a month belongs, and
   *   every one has a twin under its proper `spot_index/{YYYYMM}/` with the
   *   **same size and the same ETag** — the identical object served at a second
   *   key.
   *
   * Neither is data a consumer could want: the first cannot be placed in a
   * series at all with no dataset segment, and the second is a byte-identical
   * duplicate of a key already catalogued.
   */
  accepts: (path) => {
    const [tree, next = '', , stray] = path.split('/');

    if (! TREES.has(tree ?? '')) return false;

    /**
     * An empty `next` is the tree itself — `spot_index/` as a prefix — which is
     * what descent asks about before it can reach anything below it.
     */
    if (next !== '' && /^\d{6}$/.test(next) !== SNAPSHOTS.has(tree ?? '')) return false;

    return stray !== STRAY;
  },

  /** What this venue lists today — its only discovery. */
  instruments: gateInstruments,

  /** Reading this venue's paths back into series — see `paths.ts`. */
  inspectUrl: (path) => inspect(path),

  /**
   * `{EPOCH_HH}`, `{EPOCH_MI}` — the instant being generated, in Unix seconds.
   *
   * The two snapshot trees name a file by the moment it covers and nothing else:
   * `spot_index/202312/slice_index_1702857600`. Two slot names rather than one
   * because the number cannot say whether the next file is an hour or a minute
   * later — `spot_index` is hourly, `options_ticker` per minute — and a slot
   * ends in the grain it steps at, which is how the catalog reads the cadence
   * back off the pattern.
   */
  slotsFor: (at) => {
    const seconds = String(Date.UTC(+at.slice(0, 4), +at.slice(4, 6) - 1, +at.slice(6, 8),
      +(at.slice(8, 10) || 0), +(at.slice(10, 12) || 0)) / 1000);

    return { '{EPOCH_HH}': seconds, '{EPOCH_MI}': seconds };
  },

  /**
   * The stamp after the last `-`, or the epoch a snapshot is named for.
   *
   * **Every stamp keeps exactly the digits it was published with**, a month
   * included: a file covering all of January is `202401`, not `20240101`, which
   * would claim a day it may hold nothing for. Six characters sort correctly
   * among that month's eight-character days because a month is their prefix.
   *
   * **Nor is anything finer flattened.** Gate is the only venue here publishing
   * below a day — 24 books an hour apart, and a ticker snapshot a minute apart.
   * Flattening those to the day they fall in gives 24 files one date between
   * them, which is not a coarser answer but a wrong one: a date is what
   * distinguishes one file of a series from the next, and they would no longer.
   *
   * Lengths are enumerated rather than taken as a range: a 7- or 9-digit stamp
   * is not a shape gate publishes, and reading one as a date would place a file
   * in a month that does not exist.
   */
  dateOf: (path) => {
    /**
     * **The tree names the cadence, because the epoch cannot.** Both snapshots
     * are an instant in Unix seconds and nothing else, and the same number is a
     * different period depending on which of them it came from — the same
     * reason `slotsFor` renders two slots rather than one.
     */
    const slice = /\/slice_(index|options_ticker)_(\d{10})$/.exec(path);

    if (slice) return instantAt(Number(slice[2]) * 1000, slice[1] === 'index' ? 10 : 12);

    const stamped = /-(\d{6}|\d{8}|\d{10})\.(?:csv\.)?gz$/.exec(path);

    if (! stamped) return null;

    const stamp = stamped[1]!;

    return stamp;
  },
});

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * A UTC instant as a stamp of `width` digits — `2026060107` for an hour,
 * `202606010730` for a minute.
 *
 * The separators come out rather than the string being sliced into pieces and
 * joined, so widening a grain is one number here and nothing else.
 */
const instantAt = (ms: number, width: number): string =>
  new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, width);

/**
 * Gate: `<market>/<dataset>/<YYYYMM>/<SYMBOL>-<stamp>.csv.gz`, and one snapshot
 * shape that is nothing like it.
 *
 * **The month is a directory as well as part of the filename**, which is why the
 * date here is undashed where the others use the dashed form — and why a pattern
 * for gate carries `{YYYY}{MM}` twice.
 *
 * The stamp's length is the grain, and no dataset has to be named for it: six
 * digits a month, eight a day, ten an hour. All three sit in the same monthly
 * directory, because gate files a period under the month it falls in whatever
 * its size — `spot/candlesticks_1h/202607/BTC_USDT-202607.csv.gz` beside
 * `spot/candlesticks_1m/202608/BTC_USDT-20260801.csv.gz` beside
 * `spot/orderbooks/202108/BTC_USDT-2021082503.csv.gz`.
 *
 * The interval is folded into the dataset rather than a segment of its own:
 * `candlesticks_1m` and `candlesticks_1h` are different directories, so they are
 * different datasets by the venue's own arrangement.
 *
 * **The snapshot trees name an instant and nothing else** —
 * `spot_index/202312/slice_index_1702857600` — so their pattern has no date in
 * it at all, only the epoch slot that renders one. Both are venue-wide files
 * covering every instrument, so like okx's buckets they carry no symbol: the
 * dataset is the whole of their identity. `spot_index` is exactly hourly and
 * `options_ticker` exactly per minute, measured over a month of each, which is
 * what tells the two epoch slots apart.
 *
 * **Markets are matched by shape rather than named**, because which trees are
 * surveyed is the adapter's `accepts` to decide and not this expression's. Gate
 * has thirteen top-level trees and six of them are refused there — dead
 * branches, separate entities, and a spreadsheet folder — each with its reason
 * written beside it. Nothing here is a second opinion on that.
 */
const inspect = (path: string): Inspection => {
  const snapshot = GATE_SLICE.exec(path);

  if (snapshot) {
    const { tree, name, epoch } = snapshot.groups!;
    const grain = SLICES[tree!];

    if (! grain) return { of: 'unknown', date: null };

    const at = stampOf(Number(epoch), grain === '{EPOCH_MI}' ? 12 : 10);

    const meaning = MEANINGS[name!];

    if (! meaning) return { of: 'unknown', date: null };

    return {
      of: 'series', date: at,
      found: {
        market:  MARKET_OF[tree!] ?? tree!,
        dataset: meaning.dataset,
        ...(meaning.variant ? { variant: meaning.variant } : {}),

        /**
         * **A slice carries every instrument there is**, so the bucket symbol is
         * what it is of. Gate's own name for it is nothing at all, which is
         * exactly why the catalog gives it one.
         */
        symbol:  BUCKET,
        pattern: `${tree}/{YYYY}{MM}/slice_${name}_${grain}`,
      },
    };
  }

  const found = GATE.exec(path);

  if (! found) return { of: 'unknown', date: null };

  const { market, dataset, symbol, date } = found.groups!;

  const canonical = canonicalise(market!, dataset!);

  if (! canonical) return { of: 'unknown', date: null };

  /**
   * **Gate spells an instrument the same way everywhere**, in its keys and in
   * its own listing alike, so there is no second name to carry.
   */
  return asSeries(path, { ...canonical, symbol: symbol!, date: date! });
};

/**
 * Gate's own words for a market, in the catalog's.
 *
 * **Two trees are one market**: `futures_usdt` and `futures_btc` are both
 * perpetual swaps, differing only in what settles them — which is a property of
 * the instrument and legible from its symbol. `delivery_usdt` genuinely expires,
 * so it is not one of them.
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

/**
 * Gate's own words for a dataset, in the catalog's.
 *
 * `candlesticks_*` is absent because it is not one name but a family: the bar
 * length is spelled into it, and `canonicalise` reads it out.
 */
const MEANINGS: Record<string, { dataset: string; variant?: string }> = {
  deals:            { dataset: 'trades' },
  trades:           { dataset: 'trades' },

  /**
   * **Two funding series that mean different things.** `funding_applies` is what
   * was actually charged at the end of an interval; `funding_updates` is the
   * running estimate as it moved during one. They are not interchangeable in any
   * calculation.
   */
  funding_applies:  { dataset: 'funding', variant: 'realised' },
  funding_updates:  { dataset: 'funding', variant: 'predicted' },

  /**
   * Gate's mark price is a tick series where every other venue's is bars, so the
   * level below the name has to say which — `ticks` is a grain like any other.
   */
  mark_prices:      { dataset: 'markPrice', variant: 'ticks' },

  /**
   * **Two books, and the names say which.** `orderbooks` opens with a `set`
   * snapshot and then streams `make` and `take` deltas for the hour, at whatever
   * depth the book has — measured between 45 and 2,204 levels a side across
   * sampled symbols, so it is capped at nothing. `orderbooks_slice` is whole
   * books, twenty levels a side, one per row.
   */
  orderbooks:       { dataset: 'books', variant: 'full,incremental' },
  orderbooks_slice: { dataset: 'books', variant: '20,snapshot' },

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
  '^(?<tree>[a-z_]+)/\\d{6}/slice_(?<name>[a-z_]+)_(?<epoch>\\d{10})$');

/**
 * How often each snapshot tree publishes, since the filename cannot say.
 *
 * Established by measuring a month of each: `spot_index` gave 450 consecutive
 * gaps of 3,600 seconds and `options_ticker` 999 of 60, with no exceptions
 * either way.
 */
const SLICES: Record<string, string> = {
  spot_index:     '{EPOCH_HH}',
  options_ticker: '{EPOCH_MI}',
};

/**
 * An instant as a stamp of the given width — `2026080100` for an hour,
 * `202608010000` for a minute.
 *
 * The catalog states every bound as a stamp, so gate naming a file by its epoch
 * is read into the same vocabulary as a venue naming a date. Rendering it back
 * is `slotsFor`'s business, which is why nothing here keeps the number.
 */
const stampOf = (epoch: number, width: number): string =>
  new Date(epoch * 1000).toISOString()
    .replaceAll('-', '').replace('T', '').replaceAll(':', '').slice(0, width);


/** The trees worth surveying. Anything not named here is refused at descent. */
const TREES = new Set([
  'spot', 'futures_usdt', 'futures_btc', 'tradfi',
  'delivery_usdt', 'spot_index', 'options_ticker',
]);

/**
 * The two trees that are a dataset in themselves, and so carry a month directly
 * where every other tree carries a dataset name.
 *
 * Read as the whole of the rule rather than as an exception to it: what sits
 * one level below a tree is a month here and a dataset everywhere else, and
 * either one in the other's place is a misfiled key.
 */
const SNAPSHOTS = new Set(['spot_index', 'options_ticker']);

/**
 * A directory of spot deals filed inside the daily-candlestick tree of one
 * month: `spot/candlesticks_1d/201802/s3deals/`, 227 keys.
 *
 * Refused here rather than listed as exclusions because it is a **directory**,
 * whatever it comes to hold — the kind of thing `accepts` is for. The two
 * individual junk keys gate left in the bucket are rows in the `exclusion`
 * table instead, being exactly two files and nothing more.
 */
const STRAY = 's3deals';
