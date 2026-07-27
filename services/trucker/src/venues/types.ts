import type { ArchiveFile, Dataset, Verdict } from '../types';

/**
 * How to find one venue's archives. The core (download, resume, verify, store)
 * is written against this interface only — adding a venue is one file.
 *
 * Discovery differs fundamentally per venue: some publish an S3 listing, some an
 * HTML index, some neither (URLs are constructed from a date and probed). That
 * difference is the whole reason this interface exists.
 */
export interface VenueArchive {
  /** Venue id: the `TRUCKER_VENUES` token and the top-level storage directory. */
  name: string;

  /** The series this venue publishes that trucker fetches. */
  datasets: readonly Dataset[];

  /**
   * The oldest month this venue's archive offers, `yyyymm`.
   *
   * Where a venue with no published tip begins. Declared per venue because
   * every venue answers it differently and none of them answer it with the
   * same date: binance publishes from 2017, kucoin from 2022, htx keeps only a
   * rolling few months. A single shared default is a guess that is wrong for
   * every venue at once — too late for the old archives, which silently loses
   * years, and too early for the young ones, which buys a listing per symbol
   * per month to be told there is nothing there.
   *
   * **Every value carries its evidence in the adapter's docblock.** A floor is
   * either read from the venue or bisected against it; a number no one can
   * account for is not acceptable here.
   *
   * Too early only costs requests, too late loses data, so where the evidence
   * is thin the earlier reading wins.
   */
  floor: string;

  /**
   * Instruments available for a dataset. Read from the venue rather than
   * assumed — symbol naming varies per market on every venue tested.
   */
  symbols(dataset: Dataset): Promise<string[]>;

  /**
   * Files for one symbol, newest-last, restricted to periods after `since`
   * (exclusive) and no later than `until` (inclusive) when given.
   *
   * For venues with a listing this reads what exists. For venues without one
   * the files are *constructed* from the date range, so a returned file may not
   * exist — the downloader treats a 404 as `absent` and retries it next pass.
   *
   * `until` is the month being walked. A venue that enumerates may ignore it —
   * its listing costs the same whatever the ceiling, and the walk filters after
   * the fact. It matters where asking is priced per span: bitget's index caps a
   * query at seven days, so without a ceiling a single symbol's history would
   * cost hundreds of requests to answer a question about one month.
   */
  files(
    dataset: Dataset,
    symbol:  string,
    since:   string | null,
    until?:  string | null,
  ): Promise<ArchiveFile[]>;

  /**
   * Whether a missing file means "not published yet" (constructed URLs) rather
   * than an error. Listing-based venues never return files that do not exist.
   */
  constructsUrls?: boolean;

  /**
   * Whether every file has a `.CHECKSUM` beside it. A property of the venue,
   * not of each file — only binance and kucoin publish them — so it is declared
   * once here rather than repeated against every date in the inventory.
   */
  checksums?: boolean;

  /**
   * Set when this venue has been observed answering "absent" for a file that
   * does exist, so its absences cannot be taken at face value.
   *
   * Only OKX qualifies: the same URL has returned 404 and then 200 seconds
   * later, with no 429 and no other signal — cause unknown. For that venue an
   * absence is probed twice before it is believed and recorded in the ledger for
   * spaced re-checks, because a wrong "never published" loses the period for
   * good once the cursor steps past it.
   *
   * Everywhere else a 404 is simply true, and treating it otherwise would double
   * the request count of the probing venues to guard against a fault they have
   * never shown.
   */
  unreliableAbsence?: boolean;

  /**
   * Override how a non-2xx response is read, for venues that do not follow the
   * usual conventions. Receives the response body as well as the status —
   * error bodies are small and sometimes the only distinguishing signal.
   * Return `null` to fall through to the default.
   *
   * Bitget is why this exists: it answers **403 for a file that does not
   * exist** — verified against a bogus symbol, a bogus product type and a date
   * before listing, while a real file returns 200 immediately after. Under the
   * default rules that 403 would be read as a block and back the venue off,
   * stalling it on its first missing file. The body is what keeps that reading
   * honest: the missing-key 403 always carries S3's `AccessDenied` error
   * document, so a 403 with any other body still falls through and backs off
   * rather than being silently mistaken for absence.
   */
  classify?(status: number, body: string): Verdict | null;

  /**
   * Next part of a multi-part period, or `null` if this venue publishes one
   * file per period.
   *
   * Some venues split a day across sequence-numbered files (`…20260702_001.zip`,
   * `_002`, …) and publish no index saying how many there are. Guessing a
   * maximum silently loses data on any busier day, so instead `files()` emits
   * only the first part and the downloader follows the chain: each part that
   * lands asks for the next, and the first absent one ends the day. That costs
   * exactly one extra request per period — the terminator — and can never miss
   * a part however many there are.
   */
  continuation?(file: ArchiveFile): ArchiveFile | null;
}

/**
 * One symbol as bitget's adapter needs it: when it began trading, and the name
 * the download portal knows it by.
 *
 * The two names differ — the archive is keyed `BTCUSDT`, the index answers to
 * `BTC/USDT` — so the display form is built from the base and quote coins the
 * instruments API returns rather than guessed at by splitting the symbol, which
 * cannot be done reliably for quote currencies that are prefixes of others.
 */
export interface Listing {
  opened:  string;
  display: string;
}

/** One row of bitget's portal file-list endpoint, reduced to what trucker reads. */
export interface BitgetFile {
  dateTimeStr: string;
  displayName: string;
  fileName:    string;
  fileUrl:     string;
}

/** One row of OKX's public instruments endpoint, reduced to what trucker reads. */
export interface OkxInstrument {
  instId?:   string;
  listTime?: string;
  uly?:      string;
}

/** One page of an S3 `ListBucketResult`. */
export interface S3Page {
  prefixes: string[];
  keys:     string[];
  next:     string | null;
}

/**
 * In-process cache with an expiry, for venue instrument metadata. Without the
 * expiry a listing fetched at startup lives for the whole process, and a venue
 * that lists new symbols daily never shows them to the periodic rescan.
 */
export interface TtlCache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
  clear(): void;
}
