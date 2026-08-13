import { logger } from '@devvir/service-kit';
import config from './config';
import * as complete from './complete';
import { download } from './download';
import { record } from './absences';
import * as coverage from './coverage';
import { earliest, endOfMonth, latest, monthRange, thisMonthUTC } from './dates';
import * as inventory from './inventory';
import * as milestones from './milestones';
import { cachedSymbols } from './progress';
import { freeGb } from './store';
import { venueFor } from './venues';
import type { VenueArchive } from './venues';
import type {
  ArchiveFile, Dataset, DownloadResult, InventoryShape, Period, SyncStats,
} from './types';

const SYMBOL_TTL_SECS = 12 * 60 * 60;

/** How often the symbol walk reports itself when it is finding no work. */
const PROGRESS_EVERY = 25;

/**
 * How long "not published yet" stays a plausible reading of an absence, by the
 * span the file covers. Publication lag scales with the period: a daily file
 * lands within a day or two, a monthly one only after its month has ended, and
 * sometimes days after that — Gate's `202607` was still absent on 28 July.
 *
 * Beyond the window an absence is taken as permanent, and the cursor steps past
 * it rather than re-probing a dead date on every sweep for ever.
 */
const EDGE_DAYS: Record<Period, number> = { daily: 3, monthly: 35 };

/**
 * Fetch everything a venue has published that is not already on disk.
 *
 * **Month-major, oldest first.** A month is walked across every dataset and
 * every symbol before the next one begins, so the venue advances as a whole and
 * the months behind it are finished — not "finished for the symbols reached so
 * far". Only that ordering makes the one published fact publishable at all: a
 * symbol-major walk leaves every month partial until the entire archive is
 * collected, which is months of terabytes away, and forces every consumer to
 * reconstruct completeness from trucker's private bookkeeping.
 *
 * The past does not change and the future does, so the walk runs towards the
 * present: each pass closes what it finishes and the tip only moves forward.
 */
export const syncVenue = async (name: string): Promise<SyncStats> => {
  const venue = venueFor(name);
  const total = emptyStats();
  const walk  = await pending(venue);

  if (walk.length === 0) {
    logger.info({ venue: name, through: await complete.tip(name) }, 'Venue up to date');

    return total;
  }

  logger.info({ venue: name, from: walk[0], to: walk[walk.length - 1]! }, 'Syncing venue');

  for (const month of walk) {
    if (await outOfSpace()) break;

    merge(total, await syncMonth(venue, month));
  }

  logger.info({ venue: name, through: await complete.tip(name), ...total }, 'Venue synced');

  return total;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The months still to walk: **every month that is not closed**, from the floor
 * up to the present or the configured ceiling.
 *
 * Membership, not "after the tip". A month that fails mid-walk is left open
 * while the months after it go on to close, so starting at the tip abandons it
 * the moment anything above it succeeds — permanently, since the tip only rises.
 * bybit's 202402 and 202405 each faulted five hours into a pass in August and
 * were never looked at again; the raw for both is on disk and looks complete, so
 * one retry is all either needed.
 *
 * Closed months are skipped rather than not enumerated, which costs a set lookup
 * per month and buys a walk that repairs its own history.
 *
 * The floor is the configured one, or the venue's own — the month its archive
 * actually begins, declared by the adapter that knows and evidenced there.
 * Months below it hold nothing to find, and finding nothing is not free: on a
 * listing venue it costs a request per symbol to be told so, on every pass.
 */
const pending = async (venue: VenueArchive): Promise<string[]> => {
  const closed = await complete.closings(venue.name);
  const from   = config.startMonth ?? venue.floor;
  const to     = config.endMonth ?? thisMonthUTC();

  if (from > to) return [];

  return monthRange(from, to).filter(month => ! closed.has(month));
};

/**
 * One month, across every dataset the venue publishes.
 *
 * The month closes only when all of them finished it without a single failed
 * period. Anything less leaves it open and the next pass walks it again — the
 * tip is a promise that the month will not change, so a hole in it must hold
 * the tip back rather than be papered over.
 */
const syncMonth = async (venue: VenueArchive, month: string): Promise<SyncStats> => {
  const name  = venue.name;
  const stats = emptyStats();
  const limit = endOfMonth(month);

  // Which month is being walked, said once at its start. The per-symbol lines
  // below carry a dataset and a progress counter but no period, so without this
  // a log full of "Still walking symbols" says how far through a dataset the
  // pass is and nothing about where in the archive it stands.
  logger.info({ venue: name, month, datasets: venue.datasets.length }, 'Walking month');

  let faulted = false;

  for (const dataset of venue.datasets) {
    if (await outOfSpace()) return stats;

    // One dataset's failure — a symbols listing down, a metadata API fault —
    // must not abandon every dataset after it for the whole month.
    const one = await syncDataset(venue, dataset, limit).catch(err => {
      logger.error({ err, venue: name, dataset: dataset.id, month }, 'Dataset sync failed');

      faulted = true;

      return emptyStats();
    });

    merge(stats, one);
  }

  if (faulted || stats.failed > 0) {
    logger.warn({ venue: name, month, failed: stats.failed },
      'Month left open — it will be walked again next pass');

    return stats;
  }

  // The running edge is never closed: a monthly file can land days after its
  // month ends, and a tip that had to be retracted would be worthless.
  if (limit > edgeCutoff('monthly', new Date())) {
    logger.info({ venue: name, month }, 'Month collected but too recent to close');

    return stats;
  }

  if (await complete.publish(name, month))
    logger.info({ venue: name, month, ...stats }, 'Venue complete through month');

  return stats;
};

const syncDataset = async (
  venue:   VenueArchive,
  dataset: Dataset,
  limit:   string,
): Promise<SyncStats> => {
  const name  = venue.name;
  const stats = emptyStats();

  const all     = await cachedSymbols(name, dataset.id, SYMBOL_TTL_SECS,
    () => venue.symbols(dataset));
  const symbols = selected(all);

  const floor = config.startMonth ? `${config.startMonth}01` : null;

  // Where every symbol of this venue stands — both what has been published
  // downstream and where this pass resumes from.
  const published = await milestones.cached(name);

  // How far this pass may claim to have *looked*, whatever it finds. The month
  // being walked is the ceiling, but never nearer than the window in which an
  // absence still reads as "not published yet" — claiming coverage of a month a
  // venue has yet to upload would call it collected while files are coming.
  const reach = earliest(limit, edgeCutoff('monthly', new Date()));

  // What each symbol has been looked at through, independently of what landed.
  const looked = await coverage.cached(name);

  // What this dataset publishes, as far as it has ever been enumerated. On a
  // venue that lists, this is what turns "ask the venue what exists in this
  // month" into a lookup — the reason a month costs no requests at all once
  // its symbols have been enumerated once.
  const stock = await inventory.cached(name, dataset.id);

  logger.info(
    { venue: name, dataset: dataset.id, symbols: symbols.length, published: all.length },
    'Syncing dataset',
  );

  let index = 0;

  for (const symbol of symbols) {
    if (await outOfSpace()) return stats;

    index++;

    // The milestone is what has actually been collected; the floor only limits
    // what is asked for next. Only the former is ever written back, so setting
    // a start month never claims completeness for periods never fetched.
    const stored = milestones.settled(published, dataset.id, symbol);
    const cursor = latest(stored, floor);

    /**
     * A symbol already collected through the ceiling has nothing to offer, and
     * the answer is on disk. The other way a symbol has nothing — its archive
     * begins after the ceiling — is answered by the inventory inside
     * `offered`, which returns an empty list without asking the venue.
     */
    if (stored && stored >= limit) {
      stats.settled++;
      await coverage.publish(name, dataset.id, symbol, reach, looked);

      continue;
    }

    // A listing that failed is the one outcome that teaches nothing: the venue
    // was asked and did not answer, so the symbol keeps whatever coverage it
    // had and the next pass asks again.
    const listed = await offered(venue, dataset, symbol, cursor, limit, stock).catch(err => {
      logger.error({ err, venue: name, dataset: dataset.id, symbol }, 'Listing failed');

      return null;
    });

    if (! listed) continue;

    // The month being walked is applied here and nowhere else. Files past it are
    // simply never offered, so no cursor advances over them and the next month
    // picks up exactly where this one stopped.
    const files = listed.filter(file => file.date <= limit);

    // A settled symbol offers nothing and would otherwise pass in silence. On a
    // venue where most symbols are caught up that reads exactly like a stall,
    // so the walk reports itself periodically whether or not it finds work.
    if (index % PROGRESS_EVERY === 0)
      logger.info({ venue: name, dataset: dataset.id, month: limit.slice(0, 6), progress: `${index}/${symbols.length}`, symbol },
        'Still walking symbols');

    // Nothing new below the ceiling — the venue answered, and the answer was
    // "that is all there is". Coverage advances even though no file landed.
    if (files.length === 0) {
      await coverage.publish(name, dataset.id, symbol, reach, looked);

      continue;
    }

    stats.discovered += files.length;

    logger.info({
      venue:    name,
      dataset:  dataset.id,
      progress: `${index}/${symbols.length}`,
      from:     files[0]!.date,
      to:       files[files.length - 1]!.date,
    }, `Found ${files.length} ${symbol} files, downloading`);

    const outcomes = new Map<string, DownloadResult['status']>();

    await runPool(files, config.concurrency, async (file) => {
      const result = await fetchPeriod(name, dataset.id, file, stats);

      outcomes.set(file.url, result);
    });

    const settled = settledThrough(files, outcomes);

    // Absences the cursor is about to step past are written down first — but
    // only where `unreliableAbsence` is set, which is okx alone and is
    // documented as unfounded. Everywhere else a 404 is simply true, and
    // ledgering every unpublished date would record millions of periods that
    // never existed.
    if (settled && venue.unreliableAbsence) {
      const now = new Date().toISOString();

      for (const file of files) {
        if (file.date > settled) break;
        if (outcomes.get(file.url) !== 'absent') continue;

        await record({
          venue: name, dataset: dataset.id, symbol,
          date: file.date, period: file.period, url: file.url, path: file.path,
          firstSeen: now, lastTried: now, attempts: 1,
        });
      }
    }

    // One write, which is both the published milestone and where the next pass
    // resumes. Nothing can land between the two, because there is no second.
    if (settled) await milestones.publish(name, dataset.id, symbol, settled, published);

    // Coverage is the weaker, wider claim: the venue was asked and every file
    // it offered was resolved. A failure leaves a hole the next pass must
    // retry, so it withholds coverage exactly as it withholds the milestone.
    const failed = [...outcomes.values()].some(status => status === 'failed');

    if (! failed) await coverage.publish(name, dataset.id, symbol, reach, looked);

    logger.info({
      venue:      name,
      dataset:    dataset.id,
      progress:   `${index}/${symbols.length}`,
      downloaded: stats.downloaded,
      skipped:    stats.skipped,
      gb:         round(stats.bytes / 1e9),
    }, `${symbol} done through ${settled ?? 'nothing'}`);
  }

  return stats;
};

/**
 * Fetch everything belonging to one period, following a venue's part chain when
 * it has one. The period's status is the worst outcome in the chain, so a failed
 * part keeps the cursor from stepping over the whole day.
 */
const fetchPeriod = async (
  venue:   string,
  dataset: string,
  first:   ArchiveFile,
  stats:   SyncStats,
): Promise<DownloadResult['status']> => {
  const tally = (result: DownloadResult): void => {
    stats[result.status]++;
    stats.bytes += result.bytes;
  };

  const head = await download(venue, dataset, first);

  tally(head);

  if (head.status !== 'downloaded' && head.status !== 'skipped') return head.status;

  const next = venueFor(venue).continuation;

  if (! next) return head.status;

  let current: ArchiveFile | null = next(first);

  while (current) {
    const part = await download(venue, dataset, current);

    // An absent part is the end of the chain, not a gap — it is how a venue
    // without an index says "that was the last one".
    if (part.status === 'absent') {
      tally(part);

      return head.status;
    }

    tally(part);

    if (part.status === 'failed') return 'failed';

    current = next(current);
  }

  return head.status;
};

/**
 * The newest day the cursor may advance to: the end of the contiguous run of
 * files that are on disk.
 *
 * Progress is counted in days on every venue, whatever span its files cover — a
 * monthly file is keyed by the last day of its month, so a month that lands
 * simply advances the cursor thirty-odd days at once. That is what makes a date
 * impossible to download twice: the cursor says which days are covered, not
 * which files were fetched.
 *
 * A `failed` file always stops the run, so the next pass retries it rather than
 * stepping over a hole and never coming back. An `absent` file stops it only
 * inside its period's publication window — beyond that, absence is permanent (a
 * symbol that had not listed yet, a month a market did not trade) and blocking
 * on it would re-probe the same dead dates forever.
 */
const settledThrough = (
  files:    ArchiveFile[],
  outcomes: Map<string, DownloadResult['status']>,
  now      = new Date(),
): string | null => {
  // A date is settled only when **every** file covering it has landed. Gate
  // publishes a day of order-book deltas as 24 hourly files, so judging the
  // date on one of them would mark the whole day done while 23 hours were
  // still missing. Grouping first makes a period all-or-nothing regardless of
  // how many files a venue splits it into.
  const byDate = new Map<string, ArchiveFile[]>();

  for (const file of files) {
    const group = byDate.get(file.date);

    if (group) group.push(file);
    else byDate.set(file.date, [file]);
  }

  let settled: string | null = null;

  for (const [date, group] of [...byDate].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (! group.every(file => done(outcomes.get(file.url), file, now))) break;

    settled = date;
  }

  return settled;
};

/** Whether one file no longer stands in the way of the cursor. */
const done = (
  status: DownloadResult['status'] | undefined,
  file:   ArchiveFile,
  now:    Date,
): boolean => {
  if (status === 'downloaded' || status === 'skipped') return true;

  return status === 'absent' && file.date < edgeCutoff(file.period, now);
};

/** Periods ending before this day are old enough that absence is permanent. */
const edgeCutoff = (period: Period, now: Date): string => {
  const d = new Date(now);

  d.setUTCDate(d.getUTCDate() - EDGE_DAYS[period]);

  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

/**
 * What a symbol offers below the ceiling — from the ledger wherever the venue
 * can be enumerated, and from the venue itself only when there is something new
 * to learn.
 *
 * The archive below its trailing edge does not change, so a listing is a fact
 * to record rather than a question to repeat. Three cases, in order of cost:
 *
 * 1. **Never enumerated.** The venue is asked for the symbol's whole history,
 *    once, and the answer is written down. This is the expensive call, and it
 *    is paid once per symbol rather than once per symbol per month.
 * 2. **Enumerated and worth re-asking.** Only near the tip — see `stale`.
 * 3. **Enumerated.** No request at all; the month is answered from disk.
 *
 * Venues whose URLs are constructed keep their own path: there is no listing to
 * remember, and a ledger of guesses would be a record of what we *assumed*
 * exists, which is the one thing this must never hold.
 */
const offered = async (
  venue:   VenueArchive,
  dataset: Dataset,
  symbol:  string,
  cursor:  string | null,
  limit:   string,
  stock:   Map<string, InventoryShape>,
): Promise<ArchiveFile[]> => {
  // The walked month is the ceiling. It costs an enumerating venue nothing, and
  // it is what keeps a venue priced per span from answering about a decade to
  // settle one month.
  if (venue.constructsUrls) return venue.files(dataset, symbol, cursor, limit);

  const seen = inventory.enumerated(stock, symbol);
  const from = seen ? inventory.publishedThrough(stock, symbol) : null;

  if (! seen || stale(stock, symbol, limit)) {
    const listed = await venue.files(dataset, symbol, seen ? from : null);
    const fresh  = inventory.shapesOf(listed, new Date().toISOString());

    // Diffed before it is merged. Everything downstream — a closed month, a
    // cold-storage tar, a built partition — assumes the venue does not rewrite
    // history, so the one thing that must not happen is absorbing a
    // contradiction silently. New files at the tip are ordinary and say
    // nothing; anything else is written where a human will find it.
    const contradictions = inventory.changes(fresh, stock, seen ? from : null);

    if (contradictions.length) {
      logger.warn({ venue: venue.name, dataset: dataset.id, symbol, changes: contradictions },
        'Venue changed history it had already published — see @shared/changes');

      await inventory.flag(venue.name, dataset.id, contradictions);
    }

    await inventory.record(venue.name, dataset.id, inventory.merge(fresh, stock), stock);
  }

  return inventory.filesIn(stock, symbol, cursor, limit, venue.checksums);
};

/**
 * Whether an already-enumerated symbol is worth asking about again.
 *
 * Two things have to be true, and while a venue has a backlog neither usually
 * is. **The walk must have caught up** to what the ledger already knows: months
 * below that are settled history and re-asking cannot change them, so a venue
 * with thousands of files still to fetch spends nothing on re-listing. And the
 * symbol must still be **live** — one whose newest published file has aged past
 * the window in which an absence is still plausible has stopped publishing, and
 * a delisted symbol's history is not going to grow.
 *
 * What remains is the tip, where files genuinely appear, asked at most once per
 * configured rescan interval.
 */
const stale = (
  stock:  Map<string, InventoryShape>,
  symbol: string,
  limit:  string,
  now     = new Date(),
): boolean => {
  const through = inventory.publishedThrough(stock, symbol);

  if (! through) return true;
  if (limit < through) return false;
  if (through < edgeCutoff('monthly', now)) return false;

  const asked = inventory.askedAt(stock, symbol);

  if (! asked) return true;

  return Date.now() - Date.parse(asked) >= config.rescanHours * 3600_000;
};

/** Symbols kept by the configured tokens; every symbol when none are configured. */
const selected = (symbols: string[]): string[] => {
  if (config.symbols.length === 0) return symbols;

  return symbols.filter(s => config.symbols.some(token => s.toUpperCase().includes(token)));
};

/**
 * Best-effort guard against writing into a full volume. Checked between symbols
 * rather than between files, since a single file can be hundreds of MB and
 * stopping mid-symbol would leave a cursor claiming more than is on disk.
 */
const outOfSpace = async (): Promise<boolean> => {
  const free = await freeGb().catch(() => Infinity);

  if (free >= config.minFreeGb) return false;

  logger.error({ freeGb: Math.round(free), minFreeGb: config.minFreeGb },
    'Stopping: free disk space below the configured floor');

  return true;
};

/** Bounded-concurrency map that keeps the pool full rather than batching. */
const runPool = async <T>(
  items: T[],
  limit: number,
  work:  (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;

      await work(items[index]!);
    }
  });

  await Promise.all(workers);
};

const round = (n: number): number => Math.round(n * 10) / 10;

const emptyStats = (): SyncStats =>
  ({ discovered: 0, settled: 0, downloaded: 0, skipped: 0, absent: 0, failed: 0, bytes: 0 });

const merge = (into: SyncStats, from: SyncStats): void => {
  into.discovered += from.discovered;
  into.settled    += from.settled;
  into.downloaded += from.downloaded;
  into.skipped    += from.skipped;
  into.absent     += from.absent;
  into.failed     += from.failed;
  into.bytes      += from.bytes;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_offered        = offered;
export const _test_stale          = stale;
export const _test_runPool        = runPool;
export const _test_selected       = selected;
export const _test_settledThrough = settledThrough;
