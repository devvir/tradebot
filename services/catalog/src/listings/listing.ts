import { logger } from '@devvir/service-kit';
import { holds } from '../lenses/spans';
import { seriesFor } from '../queries';
import { nextMonth } from '../vocabulary';
import { extensionOf, partOf } from './shape';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ListingBounds, ListingFile, ListingObject, ListingPage, ListingQuery, ListingShape, ListingShelf,
  ListingStatements, LensSpan, Series,
} from '../types';

/**
 * A venue's files as one storage bucket, keyed by what each file *is*.
 *
 * **A consumer walks it as it would walk any bucket**, page after page by key,
 * whatever the venue publishes underneath — listed or probed, one host or two.
 * What a venue calls its own trees stops here: a key is the canonical archive
 * path, so a downloader writes each object at its key and needs no naming of
 * its own.
 *
 * ```
 * market/dataset[,variant]/YYYYMM/F/symbol/venue|market|dataset[,variant]|symbol|period[|part].ext
 * perp/klines,1m/202001/B/BTCUSDT/binance|perp|klines,1m|BTCUSDT|20200101.zip
 * ```
 *
 * **Keys come in byte order, as a bucket's do**, so the last key of a page is
 * all a caller needs to ask for the next one. The order is built rather than
 * sorted: folders, then months, then symbol folders, each compared with its
 * trailing `/` — `klines,1m/` sorts before `klines/` because `,` is below `/`,
 * which comparing the bare names would get backwards — and only the files of
 * one symbol in one month are sorted, a handful at a time.
 *
 * **Two files with one key is a catalog bug**, not something to settle here:
 * `accepts` and transforms exist so prospector chooses between two versions of
 * a file. Should one get through, it is logged and listed once, so paging still
 * ends.
 */
export const listingPage = (
  db:       DatabaseSync,
  venue:    string,
  venueIds: readonly number[],
  query:    ListingQuery,
): ListingPage => {
  const shape   = shapeOf(db, venue, venueIds);
  const files   = statements(db)[query.pending ? 'pending' : 'all'];
  const objects: ListingObject[] = [];
  const after   = query.after;

  /** Every key under this prefix is at or before the cursor, so none of them is owed. */
  const passed = (prefix: string): boolean =>
    after !== null && prefix < after && ! after.startsWith(prefix);

  for (const shelf of shape.shelves) {
    if (passed(shelf.prefix)) continue;

    const span = monthsOf(db, shape, shelf, query.scope);

    if (! span) continue;

    for (let month = span.first; month <= span.last; month = nextMonth(month)) {
      const monthPrefix = `${shelf.prefix}${month}/`;

      if (passed(monthPrefix)) continue;

      for (const symbol of shelf.symbols) {
        const prefix = `${monthPrefix}${symbol.prefix}`;

        if (passed(prefix)) continue;

        const found: ListingObject[] = [];

        for (const series of symbol.series) {
          const spans = query.scope ? query.scope.get(series.id!) : undefined;

          if (query.scope && (! spans || ! spans.some(one => covers(one, month)))) continue;

          const bounds = boundsOf(db, shape, series);

          if (! bounds || month < bounds.first || month > bounds.last) continue;

          for (const file of files.all(series.id!, month, nextMonth(month)) as unknown as ListingFile[]) {
            if (spans && ! holds(spans, file.date)) continue;

            const key = `${prefix}${filenameOf(venue, series, file)}`;

            if (after !== null && key <= after) continue;

            found.push({ key, file });
          }
        }

        found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

        for (const one of found) {
          const last = objects[objects.length - 1];

          if (last && last.key === one.key) {
            logger.error({ venue, key: one.key, paths: [last.file.path, one.file.path] },
              'Two catalogued files share one bucket key — listing the first');

            continue;
          }

          objects.push(one);

          // One past the page answers "is there more" without a second walk.
          if (objects.length > query.maxKeys) return { objects: objects.slice(0, query.maxKeys), truncated: true };
        }
      }
    }
  }

  return { objects, truncated: false };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * How long a venue's shelves and series bounds are held between pages.
 *
 * Long enough that walking a bucket does not rebuild them for every page, short
 * enough that a series a survey just found, or a file it found outside a
 * series' months, is in the next walk. A file added behind a walk's cursor is
 * found by the next walk, as on any bucket.
 */
const KEEP_MS = 60_000;

const SHAPES = new Map<string, ListingShape>();

/** `market/dataset[,variant]` — no comma where the dataset has no variant. */
const folderOf = (series: Series): string =>
  `${series.market}/${series.variant ? `${series.dataset},${series.variant}` : series.dataset}`;

/**
 * `venue|market|dataset[,variant]|symbol|period[|part].ext` — the whole identity,
 * so a reader can parse a name without learning where it lives.
 */
const filenameOf = (venue: string, series: Series, file: { date: string; path: string }): string => {
  const dataset = series.variant ? `${series.dataset},${series.variant}` : series.dataset;
  const part    = partOf(file.path, series.pattern);
  const fields  = [venue, series.market, dataset, series.symbol, file.date];

  if (part !== undefined) fields.push(part);

  return `${fields.join('|')}${extensionOf(file.path)}`;
};

/**
 * The folder a symbol sits under: its first letter, uppercased, or `_`.
 *
 * A filesystem device rather than a fact about the data: a few dozen folders per
 * letter list and browse in a way that thousands side by side do not.
 */
const letterOf = (symbol: string): string => {
  const first = symbol.slice(0, 1).toUpperCase();

  return /^[A-Z]$/.test(first) ? first : '_';
};

/**
 * A venue's series as its bucket orders them: folders, then symbol folders,
 * each sorted with its trailing `/` so that order is the keys' own.
 *
 * A symbol holding `/` cannot be a folder name and would corrupt every key
 * after it, so it is logged and left out rather than listed wrongly.
 */
const shapeOf = (db: DatabaseSync, venue: string, venueIds: readonly number[]): ListingShape => {
  const id   = `${venue}:${venueIds.join(',')}`;
  const held = SHAPES.get(id);

  if (held && Date.now() - held.at < KEEP_MS) return held;

  const folders = new Map<string, Map<string, Series[]>>();

  for (const venueId of venueIds)
    for (const series of seriesFor(db, venueId)) {
      if (series.symbol === '' || series.symbol.includes('/')) {
        logger.error({ venue, symbol: series.symbol, seriesId: series.id },
          'A series whose symbol cannot be a folder name — left out of the bucket');

        continue;
      }

      const folder  = `${folderOf(series)}/`;
      const symbols = folders.get(folder) ?? new Map<string, Series[]>();
      const prefix  = `${letterOf(series.symbol)}/${series.symbol}/`;

      folders.set(folder, symbols);
      symbols.set(prefix, [...(symbols.get(prefix) ?? []), series]);
    }

  const shelves: ListingShelf[] = [...folders]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, symbols]) => ({
      prefix,
      symbols: [...symbols]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([symbolPrefix, series]) => ({ prefix: symbolPrefix, series })),
    }));

  const shape: ListingShape = { at: Date.now(), shelves, bounds: new Map() };

  SHAPES.set(id, shape);

  return shape;
};

/**
 * The first and last month a series has files in.
 *
 * **The first is read off `file`**, one indexed seek: the series row's own
 * `first` is where generation was established to start, not a promise that no
 * file sits below it, and a listing that trusted it would skip real files
 * without a word. **The last is the row's `last`**, which only ever moves
 * forward — so it may sit above the newest file, costing an empty seek, but
 * never below one. Read off `file` only where the row has none.
 *
 * One seek per series rather than two is what keeps a walk's first page quick
 * on a venue a lens mostly leaves out: measured 2026-10-01, kucoin under a lens
 * holding none of its months spent 3.8 s on two seeks per series before saying
 * so.
 */
const boundsOf = (db: DatabaseSync, shape: ListingShape, series: Series): ListingBounds | null => {
  const seriesId = series.id!;

  if (shape.bounds.has(seriesId)) return shape.bounds.get(seriesId)!;

  const read  = statements(db);
  const first = (read.first.get(seriesId) as { at: string | null }).at;
  const last  = series.last ?? (read.last.get(seriesId) as { at: string | null }).at;

  const bounds = first && last ? { first: first.slice(0, 6), last: last.slice(0, 6) } : null;

  shape.bounds.set(seriesId, bounds);

  return bounds;
};

/** The months a folder spans, across the series a lens lets through, or null where it has none. */
const monthsOf = (
  db:    DatabaseSync,
  shape: ListingShape,
  shelf: ListingShelf,
  scope: ReadonlyMap<number, readonly LensSpan[]> | null,
): ListingBounds | null => {
  let first: string | null = null;
  let last:  string | null = null;

  for (const symbol of shelf.symbols)
    for (const series of symbol.series) {
      if (scope && ! scope.has(series.id!)) continue;

      const bounds = boundsOf(db, shape, series);

      if (! bounds) continue;

      if (first === null || bounds.first < first) first = bounds.first;
      if (last  === null || bounds.last  > last)  last  = bounds.last;
    }

  return first !== null && last !== null ? { first, last } : null;
};

/** Whether a span reaches into a month at all. */
const covers = (span: LensSpan, month: string): boolean =>
  (span.from === null || month >= span.from) && (span.to === null || month <= span.to);

/**
 * The statements a listing runs, prepared once per database.
 *
 * **`pending` reads its own index**, the files not yet downloaded, so a walk of
 * what is owed costs what is owed — never every file the lens covers, which on
 * a backfilled archive is millions of rows to find a handful.
 */
const statements = (db: DatabaseSync): ListingStatements => {
  let held = PREPARED.get(db);

  if (! held) {
    const columns = `rowid AS id, venue_id AS venueId, path, date, size, etag, modified, series_id AS seriesId`;

    held = {
      all: db.prepare(
        `SELECT ${columns} FROM file
          WHERE series_id = ? AND date >= ? AND date < ? AND existence = 'confirmed'
          ORDER BY date, path`),
      pending: db.prepare(
        `SELECT ${columns} FROM file
          WHERE series_id = ? AND date >= ? AND date < ?
            AND downloaded_at IS NULL AND existence = 'confirmed'
          ORDER BY date, path`),
      first: db.prepare('SELECT MIN(date) AS at FROM file WHERE series_id = ?'),
      last:  db.prepare('SELECT MAX(date) AS at FROM file WHERE series_id = ?'),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, ListingStatements>();

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_shapes = SHAPES;
