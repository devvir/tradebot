import { after, postJson, ttlCache } from './listing';
import { ARCHIVED_FUTURES, ARCHIVED_SPOT } from './bitget.symbols';
import { dashed, dateRange, latest, msToYMD, nextDay, yesterdayUTC } from '../dates';
import type { ArchiveFile, Dataset } from '../types';
import type { BitgetFile, Listing, VenueArchive } from './types';

const HOST = 'https://img.bitgetimg.com/online';

/**
 * The portal's own file-list call, which needs no cookie and no token.
 *
 * Used **only where constructing a URL cannot work**. It is undocumented, so
 * the less it is leaned on the better: the modern era is probed exactly as
 * before, and this answers the one question probing cannot — what the archive
 * held before bitget changed how it names files.
 */
const INDEX = 'https://www.bitget.com/v1/statistics/public/download/getPublicDataV2';

/**
 * Where the **constructed** filename shape begins. Bisected on BTCUSDT:
 * `20240417` absent, `20240418` present, identically for spot trades, futures
 * trades and klines.
 *
 * It is not where the archive begins. Bitget publishes the same series from
 * 2018 under an older name — `BTCUSDT_SP_1min_20200803.zip` beside
 * `SP/20200804.zip`, both live, interleaved inside one week — which no template
 * reaches. Above this date the shape is uniform and probing answers everything;
 * below it, only the index knows.
 */
const START = '20240418';

/** The last date served under the older naming, the day before the shape changed. */
const LEGACY_THROUGH = '20240417';

/**
 * The oldest date the index reports for **spot**: the day after ETHUSDT (16:40
 * UTC) and BTCUSDT (17:46 UTC) first traded. Bitget does not publish the
 * partial launch day — a window covering 2018-07-24 comes back starting at the
 * 25th.
 */
const ARCHIVE_FROM = '20180725';

/**
 * Where **futures** begin, bracketed on BTCUSDT klines: 2019-06-01 comes back
 * empty, 2019-08-01 returns a file. The exact day between the two is not
 * pinned down, and the earlier reading is the safe one — a floor that is too
 * early costs index queries, never data.
 */
const FUTURES_FROM = '20190601';

/** The index rejects any window wider than this. */
const WINDOW_DAYS = 7;

/** Symbols one query may name. The portal's own form allows five. */
const BATCH = 5;

/** Windows kept in memory — a month is five, so this holds the walk's vicinity. */
const WINDOWS_HELD = 12;

/** window key → display symbol → its rows, filled a batch at a time. */
const batches = new Map<string, Map<string, BitgetFile[]>>();

/** Which series the index calls what. */
const BUSINESS_TYPE: Record<string, number> = { klines: 1, trades: 2, book: 3 };

/**
 * Spot and futures are separate catalogues to the index, and they disagree
 * about how a symbol is spelt: spot answers to `BTC/USDT`, futures to the plain
 * `BTCUSDT`. Asking with the wrong form returns an empty list rather than an
 * error, so this is the difference between reading the archive and concluding
 * it is not there.
 */
const SPOT_LINE    = 1;
const FUTURES_LINE = 2;

/**
 * Bitget publishes no listing (its CDN answers 403 to any directory or
 * bucket-style query), so URLs are constructed and probed.
 *
 * Two things make it unlike every other venue here:
 *
 * 1. **403 means "does not exist".** Every miss — bogus symbol, bogus product
 *    type, date below the floor, part number past the end, and a genuinely
 *    malformed path — returns the same 111-byte
 *    `<Error><Code>AccessDenied</Code></Error>`, while a real file returns 200.
 *    That is S3 answering `GetObject` on a missing key when the bucket policy
 *    grants `s3:GetObject` but not `s3:ListBucket`: 403 rather than 404 exactly
 *    so the response cannot be used to probe for key existence. Nothing here
 *    ever answers 404, and a real rate limit would arrive as 429 or 503, so
 *    reading 403 as absent does not mask throttling.
 * 2. **A day of trades is split into parts**, `…/{date}_001.zip`, `_002`, …
 *    with no index saying how many. `files()` emits only part 001 and
 *    `continuation` walks the rest until one is absent, so a day of any length
 *    is captured in full at the cost of one terminating request. Klines are a
 *    single file per day.
 *
 * The path layout also differs between the two: trades put the product type
 * before the symbol, klines put the symbol first.
 */
export const bitget: VenueArchive = {
  name: 'bitget',

  constructsUrls: true,

  /**
   * The month spot begins, which is the earliest of any catalogue here —
   * futures start in 2019, and both are reached through the index rather than
   * by constructing URLs.
   *
   * **This is deliberately six years below the old value.** `20240418` is where
   * the constructed filename shape starts, not where the archive does; walking
   * from 2018 is the point of reading the index at all. Months between the two
   * were previously published as complete while holding nothing.
   */
  floor: ARCHIVE_FROM.slice(0, 6),

  /**
   * Only the S3 missing-key 403 — the `AccessDenied` error document — reads as
   * absent. A 403 with any other body is not one of those, whatever it is, and
   * falls through to the default, which backs the venue off. Without the body
   * check a real CDN block would be read as "never published" on every file it
   * covered, and the cursor would step past them all for good.
   */
  classify: (status, body) =>
    (status === 403 && body.includes('<Code>AccessDenied</Code>') ? 'absent' : null),

  // Only days are published — no monthly file was found at any pattern tried —
  // so the cutover never applies and days are taken for the whole range.
  datasets: [
    { id: 'spot-trades',  kind: 'trades', market: 'SPBL',  path: 'trades' },
    { id: 'umcbl-trades', kind: 'trades', market: 'UMCBL', path: 'trades' },
    { id: 'dmcbl-trades', kind: 'trades', market: 'DMCBL', path: 'trades' },
    // USDC-margined perps — 49 contracts, filed under their own `CMCBL` token.
    { id: 'cmcbl-trades', kind: 'trades', market: 'CMCBL', path: 'trades' },
    // The product-type token differs per data type: spot trades are `SPBL`,
    // spot klines are `SP`. Futures use the same token for both.
    { id: 'spot-klines',  kind: 'klines', market: 'SP',    path: 'kline'  },
    { id: 'umcbl-klines', kind: 'klines', market: 'UMCBL', path: 'kline'  },
    { id: 'dmcbl-klines', kind: 'klines', market: 'DMCBL', path: 'kline'  },
    { id: 'cmcbl-klines', kind: 'klines', market: 'CMCBL', path: 'kline'  },

    // "Depth" is best bid/ask over time — `timestamp, askPrice, bidPrice,
    // askVolume, bidVolume`, i.e. level 1 only, not a depth ladder. A third
    // path shape again: `depth/{SYMBOL}/{1|2}/{date}.zip`, where 1 is spot and
    // 2 futures (a spot-only pair such as LTCBTC answers absent under 2).
    { id: 'spot-depth',    kind: 'book', market: '1', path: 'depth' },
    { id: 'futures-depth', kind: 'book', market: '2', path: 'depth' },
  ],

  symbols: async (dataset) => [...(await listings(dataset)).keys()].sort(),

  files: async (dataset, symbol, since, until) => {
    // Starting each symbol at its own listing date is what keeps this venue
    // affordable: without it every symbol is probed from the archive floor
    // regardless of when it began trading, across six datasets and ~1,900
    // symbols. Symbols whose listing date the API omits fall back to the floor,
    // so the range can only ever be too wide, never too narrow.
    const meta   = (await listings(dataset)).get(symbol);
    const listed = meta?.opened ?? floorOf(dataset);
    const from   = latest(since ? nextDay(since) : floorOf(dataset), listed);
    const to     = until ?? yesterdayUTC();

    if (from > to) return [];

    // Two eras, one boundary: everything above it is constructed and probed,
    // everything below it has to be asked for.
    //
    // The index era is bounded at **both** ends. A cursor bounds it from below
    // once a symbol has collected anything, but a symbol that has yet to would
    // otherwise be asked about its whole history again every month — at a
    // request per week walked, which is how a cheap lookup turns into hundreds.
    // The walk is month-major and oldest-first, so months below the one being
    // walked have already been asked about.
    const old   = await legacy(dataset, symbol, meta,
      latest(from, monthStart(until)), earlier(to, LEGACY_THROUGH));
    const dates = dateRange(latest(from, START), to);

    return after([...old, ...constructed(dataset, symbol, dates)], since);
  },

  continuation: (file) => {
    const m = file.path.match(/^trades\/([^/]+)\/([^/]+)\/(\d{8})_(\d{3})\.zip$/);

    if (! m) return null;   // klines are single-file

    return partFile(m[1]!, m[2]!, m[3]!, Number(m[4]) + 1);
  },
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Files whose URL this venue can build without asking anyone. */
const constructed = (
  dataset: Dataset,
  symbol:  string,
  dates:   readonly string[],
): ArchiveFile[] =>
  dataset.kind === 'trades'
    // Only the first part; `continuation` discovers however many follow.
    ? dates.map(date => partFile(dataset.market, symbol, date, 1))
    // Klines and depth share a shape — `{path}/{SYMBOL}/{token}/{date}.zip` —
    // with the symbol ahead of the product token, the reverse of trades.
    : dates.map<ArchiveFile>((date) => {
      const path = `${dataset.path}/${symbol}/${tokenOf(dataset)}/${date}.zip`;

      return { url: `${HOST}/${path}`, path, date, symbol, period: 'daily' };
    });

/**
 * The pre-2024 archive, read from the index because its filenames cannot be
 * built.
 *
 * Deliberately narrow. It runs only below `START`, only for spot — the index's
 * futures symbol form is not established, and inventing one would fabricate
 * URLs — and only across the window the walk actually asked about, which is one
 * month. At seven days per query that is five requests to settle a symbol's
 * month, against hundreds to enumerate its history for the same answer.
 *
 * The response repeats every file four times and its `_001`/`_002` parts arrive
 * as their own rows, so it is deduplicated by URL and the parts are taken as
 * given rather than discovered by probing for the first absent one.
 */
const legacy = async (
  dataset: Dataset,
  symbol:  string,
  meta:    Listing | undefined,
  from:    string,
  to:      string,
): Promise<ArchiveFile[]> => {
  const type    = BUSINESS_TYPE[dataset.kind];
  const display = spot(dataset) ? meta?.display : symbol;

  if (from > to || ! type || ! display) return [];

  const seen  = new Map<string, ArchiveFile>();
  const line  = spot(dataset) ? SPOT_LINE : FUTURES_LINE;
  const ahead = await neighbours(dataset, symbol);

  for (const [begin, end] of windows(latest(from, floorOf(dataset)), to)) {
    for (const row of await rowsFor(display, ahead, line, type, begin, end)) {
      const path = row.fileUrl.replace(`${HOST}/`, '');

      // A URL that does not sit under the CDN root cannot be stored beneath the
      // venue's directory, and guessing a path for it would put it anywhere.
      if (path === row.fileUrl) continue;

      // One query can only answer for one dataset. The futures line covers both
      // margin types at once, so a row is kept only where its own path says it
      // belongs here — otherwise a coin-margined file lands in the USDT tree.
      if (! belongs(dataset, symbol, path)) continue;

      seen.set(row.fileUrl, {
        url:    row.fileUrl,
        path,
        date:   row.dateTimeStr.replace(/-/g, ''),
        symbol,
        period: 'daily',
      });
    }
  }

  return [...seen.values()];
};

/**
 * Whether a row the index returned is this dataset's file.
 *
 * Read from the path rather than trusted, because the query cannot express the
 * distinction: one futures request answers for USDT- and coin-margined alike,
 * and the reply says which only in the key.
 */
const belongs = (dataset: Dataset, symbol: string, path: string): boolean => {
  const parts = path.split('/');

  if (parts[0] !== dataset.path) return false;

  // Trades put the product type before the symbol; klines and depth after it.
  if (dataset.kind === 'trades') return parts[1] === dataset.market && parts[2] === symbol;

  if (parts[1] !== symbol) return false;

  const token = tokenOf(dataset);

  // The token is a directory in the modern shape and part of the filename in
  // the older one — `BTCUSDT_UMCBL_1min_20200801.zip`.
  return parts[2] === token || (parts[2]?.includes(`_${token}_`) ?? false);
};

/**
 * The product token klines and depth file a symbol under.
 *
 * **Coin-margined klines are filed under `UMCBL`**, not `DMCBL`:
 * `kline/BTCUSD/UMCBL/20250601.zip` serves 200 while the `DMCBL` spelling
 * answers 403. That is why `dmcbl-klines` looked like a dataset publishing
 * nothing — 55 of 55 probes missed by one path segment. Trades are unaffected;
 * they use the real product type (`trades/DMCBL/BTCUSD/…`).
 */
const tokenOf = (dataset: Dataset): string =>
  dataset.kind === 'klines' && ! spot(dataset) ? 'UMCBL' : dataset.market;

/**
 * One window's rows for a symbol, asking about several symbols at once.
 *
 * A query costs the same whether it names one symbol or five, and the seven-day
 * cap is not negotiable — so for bitget's ~1,900 symbols across six years, one
 * symbol per call is about 1.1 M requests against an endpoint that answers 429
 * under load, and five is about 220 k. That ratio is the difference between a
 * backfill that runs and one that does not.
 *
 * The walk visits symbols in sorted order, so the four asked about alongside
 * this one are the four it reaches next, and each is already answered when its
 * turn comes. Windows are held only while the walk is inside them: a month is
 * five of them, and the oldest is dropped once a dozen have accumulated.
 *
 * A symbol the reply does not mention is recorded as having nothing, so it is
 * never asked about twice.
 */
const rowsFor = async (
  display: string,
  ahead:   readonly string[],
  line:    number,
  type:    number,
  begin:   string,
  end:     string,
): Promise<BitgetFile[]> => {
  const key = `${line}|${type}|${begin}|${end}`;

  let window = batches.get(key);

  if (! window) {
    window = new Map<string, BitgetFile[]>();
    batches.set(key, window);

    if (batches.size > WINDOWS_HELD) batches.delete(batches.keys().next().value!);
  }

  if (! window.has(display)) {
    const batch = [display, ...ahead.filter(name => ! window!.has(name))].slice(0, BATCH);
    const rows  = await listed(batch, line, type, begin, end);

    for (const name of batch) window.set(name, []);

    // Rows are attributed by the name they carry. A row naming nobody in the
    // batch is only safe to keep when the batch named one symbol, where there
    // is nothing to confuse it with — otherwise it is dropped rather than filed
    // under a guess, since a misattributed file is worse than a missing one.
    for (const row of rows) {
      const owner = window.has(row.displayName) ? row.displayName
        : (batch.length === 1 ? batch[0]! : null);

      if (owner) window.get(owner)!.push(row);
    }
  }

  return window.get(display) ?? [];
};

/**
 * The symbols the walk will reach next, to be asked about alongside this one.
 * Sorted because that is the order `symbols()` hands the walk.
 */
const neighbours = async (dataset: Dataset, symbol: string): Promise<string[]> => {
  const known  = await listings(dataset);
  const sorted = [...known.keys()].sort();
  const at     = sorted.indexOf(symbol);

  if (at < 0) return [];

  return sorted.slice(at + 1, at + BATCH)
    .map(name => (spot(dataset) ? known.get(name)!.display : name));
};

/** One index query. Anything but a `200` body is a failure the sweep retries. */
const listed = async (
  display: readonly string[],
  line:    number,
  type:    number,
  begin:   string,
  end:     string,
): Promise<BitgetFile[]> => {
  const body = await postJson<{ code?: string; data?: BitgetFile[] }>(INDEX, {
    displaySymbol: [...display],
    businessLine:  line,
    businessType:  type,
    dateType:      1,
    beginTimeStr:  dashed(begin),
    endTimeStr:    dashed(end),
  });

  if (body.code !== '200')
    throw new Error(`Bitget index refused ${body.code} for ${display.join(', ')}`);

  return body.data ?? [];
};

/** `[begin, end]` spans of at most a week, since the index rejects anything wider. */
const windows = (from: string, to: string): [string, string][] => {
  const spans: [string, string][] = [];
  const days  = dateRange(from, to);

  for (let i = 0; i < days.length; i += WINDOW_DAYS)
    spans.push([days[i]!, days[Math.min(i + WINDOW_DAYS, days.length) - 1]!]);

  return spans;
};

/**
 * Where a dataset's history starts.
 *
 * Both catalogues reach back past the constructed shape through the index, and
 * they begin at different times — spot in 2018, futures in 2019. A dataset the
 * index has no business type for stops at the constructed shape, because that
 * is as far as its URLs can be built.
 */
const floorOf = (dataset: Dataset): string => {
  if (! BUSINESS_TYPE[dataset.kind]) return START;

  return spot(dataset) ? ARCHIVE_FROM : FUTURES_FROM;
};

const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * The first day of the month being walked, or nothing when no ceiling is set.
 *
 * Only the index era uses this. Constructed dates cost nothing to build and the
 * walk filters them, but every date asked of the index is a request, so the
 * question is narrowed to the month that is actually being settled.
 */
const monthStart = (until: string | null | undefined): string =>
  (until ? `${until.slice(0, 6)}01` : '');

/**
 * symbol → listing date and the index's own name for it, per market, cached
 * with an expiry so the periodic rescan discovers new listings. An empty or
 * non-2xx answer throws rather than caching — a cached empty universe would
 * silently collect nothing.
 */
const cache = ttlCache<Map<string, Listing>>(12 * 60 * 60 * 1000);

/**
 * Symbols with the date each began trading.
 *
 * The field is `openTime`, in milliseconds. `launchTime` is documented but comes
 * back empty for every contract, and `openTime` itself is only populated for the
 * newer ones — 599 of 722 USDT futures, 11 of 16 coin futures, but all 1,181
 * spot symbols. The blanks are the older listings, which is why the fallback is
 * the archive floor rather than anything cleverer.
 */
const listings = async (dataset: Dataset): Promise<Map<string, Listing>> => {
  const market = dataset.market;
  const cached = cache.get(market);

  if (cached) return cached;

  const urls = spot(dataset)
    ? ['https://api.bitget.com/api/v2/spot/public/symbols']
    : productTypes(dataset).map(type =>
      `https://api.bitget.com/api/v2/mix/market/contracts?productType=${type}`);

  const map = new Map<string, Listing>();

  for (const url of urls) {
    const res = await fetch(url);

    if (! res.ok) throw new Error(`Bitget symbols listing failed ${res.status} for ${market}`);

    const body = await res.json() as {
      data?: { symbol: string; openTime?: string; baseCoin?: string; quoteCoin?: string }[];
    };

    for (const entry of body.data ?? []) {
      const opened = Number(entry.openTime);

      map.set(entry.symbol, {
        opened: Number.isFinite(opened) && opened > 0 ? msToYMD(opened) : floorOf(dataset),

        // The index answers to `BTC/USDT` where the archive is keyed `BTCUSDT`.
        // Built from the two coins rather than by splitting the symbol, which
        // cannot be done for a quote currency that prefixes another. Futures
        // answer to the plain symbol, so their display form is the symbol.
        display: spot(dataset) && entry.baseCoin && entry.quoteCoin
          ? `${entry.baseCoin}/${entry.quoteCoin}`
          : entry.symbol,
      });
    }
  }

  if (map.size === 0) throw new Error(`Bitget returned no symbols for ${market}`);

  // Symbols that have since delisted are in no version of that answer, and
  // their files are still served — so the archive is reachable only for as long
  // as the name is known. The seed supplies names, the API supplies everything
  // else, and a symbol in both is the API's. A dead symbol has no listing date
  // left to read, so it is walked from the venue floor.
  for (const display of spot(dataset) ? ARCHIVED_SPOT : ARCHIVED_FUTURES) {
    const symbol = display.replace('/', '');

    if (map.has(symbol)) continue;

    map.set(symbol, { opened: floorOf(dataset), display });
  }

  cache.set(market, map);

  return map;
};

const spot = (dataset: Dataset): boolean =>
  dataset.market === 'SPBL' || dataset.market === 'SP' || dataset.market === '1';

const partFile = (market: string, symbol: string, date: string, part: number): ArchiveFile => {
  const path = `trades/${market}/${symbol}/${date}_${String(part).padStart(3, '0')}.zip`;

  return { url: `${HOST}/${path}`, path, date, symbol, period: 'daily' };
};

/**
 * Which instrument catalogues a dataset draws its symbols from.
 *
 * Three futures markets, not two: USDT-margined, coin-margined, and the
 * USDC-margined perps bitget files under `CMCBL`. Depth does not separate them —
 * one path serves every futures symbol — so it enumerates all three.
 */
const productTypes = (dataset: Dataset): string[] => {
  if (dataset.market === 'DMCBL') return ['COIN-FUTURES'];
  if (dataset.market === 'CMCBL') return ['USDC-FUTURES'];
  if (dataset.market === 'UMCBL') return ['USDT-FUTURES'];

  return ['USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES'];
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_resetCache = (): void => {
  cache.clear();
  batches.clear();
};
