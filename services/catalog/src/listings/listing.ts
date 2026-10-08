import { logger } from '@devvir/service-kit';
import { depthOf, keyOf } from './keys';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ListingObject, ListingPage, ListingQuery, ListingRow, Within } from '../types';

/**
 * The catalog as one storage bucket: every venue's files, keyed by what each
 * file *is* — see `keyOf` — and walked page after page by key, as any bucket is.
 * A venue is a prefix (`gate/`), as is anything narrower.
 *
 * **A page is one query.** Keys sort by series prefix, then date, then part, and
 * that is how the rows are indexed: `series.prefix` from where the page starts,
 * and each series' files by `(series_id, date)`. Through a lens, only the series
 * of a slice the lens holds a partition of are walked, and each one's files are
 * read only within the months the lens lets through.
 * The page reads until it is full and stops; nothing behind the cursor, outside
 * the prefix or outside the lens is read.
 *
 * **The only sorting is within one prefix**, where several series meet — a
 * monthly and a daily rendering of one instrument, two eras of it — and their
 * files are one stream by date.
 *
 * **One partition is a filter like a lens of one**: only the series of its slice
 * are walked, and each one's files read only within its month.
 *
 * **Two files with one key is a catalog bug**, not something to settle here:
 * `accepts` and transforms exist so prospector chooses between two versions of
 * a file. Should one get through, it is logged and listed once, so paging still
 * ends.
 */
export const listingPage = (db: DatabaseSync, query: ListingQuery): ListingPage => {
  const start   = query.after !== null && query.after > query.prefix ? query.after : query.prefix;
  const from    = startOf(start);
  const until   = query.prefix === '' ? LAST : ceiling(seriesPart(query.prefix));
  const objects: ListingObject[] = [];
  const within  = query.partition != null ? 'partition' : query.lens ? 'lens' : 'all';
  const read    = statements(db)[`${within}:${query.pending ? 'pending' : 'any'}`]!;
  // The partition or the lens, where there is one, then where the page starts, where the prefix ends, and the date to start from.
  const asked   = [query.partition ?? query.lens?.id ?? null, from.prefix, until, from.date];

  for (const row of read.iterate(...asked) as Iterable<ListingRow>) {
    const key = keyOf(row.prefix, row.pattern, row);

    if (query.after !== null && key <= query.after) continue;
    if (key < query.prefix) continue;
    if (! key.startsWith(query.prefix)) break;

    const last = objects[objects.length - 1];

    if (last && last.key === key) {
      logger.error({ key, paths: [last.file.path, row.path] }, 'Two catalogued files share one key — listing the first');

      continue;
    }

    objects.push({ key, file: row });

    // One past the page answers "is there more" without a second query.
    if (objects.length > query.maxKeys) return { objects: objects.slice(0, query.maxKeys), truncated: true };
  }

  return { objects, truncated: false };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Above every key. */
const LAST = '\u{10FFFF}';

/**
 * Where a page starts: the series prefix the cursor is in, and the date in it.
 *
 * **Read off the key itself**, so S3's marker is the whole cursor and nothing is
 * held between pages. What sorts before that prefix and date is behind the
 * cursor and is not read; what is left of the cursor's own date is read and
 * dropped key by key. A cursor shorter than a series prefix — a venue, a dataset,
 * a client's own marker — starts at itself.
 */
const startOf = (start: string): { prefix: string; date: string } => {
  const parts = start.split('/');
  const depth = depthOf(parts);

  if (parts.length < depth + 1) return { prefix: start, date: '' };

  const name = parts[depth + 1];
  const date = name === undefined ? parts[depth]! : name.split('|')[4]?.split('.')[0] ?? parts[depth]!;

  return { prefix: `${parts.slice(0, depth).join('/')}/`, date };
};

/** The series prefix a listing prefix reaches into: the prefix itself, cut at the symbol. */
const seriesPart = (prefix: string): string => {
  const parts = prefix.split('/');
  const depth = depthOf(parts);

  return parts.length < depth + 1 ? prefix : `${parts.slice(0, depth).join('/')}/`;
};

/** The first string past everything that starts with this one. */
const ceiling = (prefix: string): string =>
  prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

/**
 * The page queries, prepared once per database: through a lens or not, owed or
 * not.
 *
 * **`pending` reads its own index**, the files not yet downloaded, so a walk of
 * what is owed costs what is owed — never every file the lens covers, which on
 * a backfilled archive is millions of rows to find a handful. And it reads only
 * the partitions that owe anything: each counts its own pending files, so a
 * series is not asked about a month with none.
 *
 * **`CROSS JOIN` fixes the order**: SQLite never reorders one, so the walk is
 * always the series in prefix order, with the lens looked up for each — the
 * partitions of its slice the lens lets through, and one read of its files per
 * month.
 *
 * **The slices a lens touches are worked out once per page**, before the walk,
 * so a series of any other slice is passed over at the cost of one lookup. Left to
 * choose, it drove from the lens's rows on the real catalog and sorted the whole
 * result before the first key: 55 seconds for three pages of gate, where the walk
 * answers in a fraction of one.
 */
const statements = (db: DatabaseSync): Record<string, StatementSync> => {
  let held = PREPARED.get(db);

  if (! held) {
    const query = (within: Within, pending: boolean) => db.prepare(
      `SELECT s.prefix, p.pattern, f.rowid AS id, f.venue_id AS venueId, f.path, f.date, f.size, f.etag,
              f.modified, f.series_id AS seriesId
         FROM series s
         CROSS JOIN pattern p ON p.id = s.pattern_id
         ${members(within, pending)}
         CROSS JOIN file f ON f.series_id = s.id${within !== 'all' || pending ? " AND f.date >= q.month AND f.date <= q.month || '99'" : ''}
        WHERE s.prefix >= ?2 AND s.prefix < ?3
          AND (s.prefix, f.date) >= (?2, ?4)${touched(within, pending)}
          AND f.existence = 'confirmed'${pending ? ' AND f.downloaded_at IS NULL' : ''}
        ORDER BY s.prefix, f.date, f.path`);

    held = {
      'all:any':           query('all', false),
      'all:pending':       query('all', true),
      'lens:any':          query('lens', false),
      'lens:pending':      query('lens', true),
      'partition:any':     query('partition', false),
      'partition:pending': query('partition', true),
    };

    PREPARED.set(db, held);
  }

  return held;
};

/**
 * The partitions of a series' slice that a walk reads: all of them where there
 * is neither a lens nor a question of what is owed — then there is no join at
 * all — and otherwise those the lens lets through or the one partition named,
 * those still owing a file, or both.
 */
const members = (within: Within, pending: boolean): string =>
  (within === 'all' && ! pending ? '' : `
         CROSS JOIN partition q ON q.slice_id = p.slice_id${within === 'partition' ? ' AND q.id = ?1' : ''}${pending ? ' AND q.pending > 0' : ''}${within === 'lens' ? `
         CROSS JOIN lens_member l ON l.lens_id = ?1 AND l.partition_id = q.id` : ''}`);

/**
 * The slices a walk reads at all: those with a partition the lens lets through,
 * still owing a file where that is what is asked. Worked out once per page, so
 * a series of any other slice costs one lookup rather than one per month.
 */
const touched = (within: Within, pending: boolean): string =>
  (within === 'partition' ? `
          AND p.slice_id = (SELECT slice_id FROM partition WHERE id = ?1)`
    : within === 'lens' ? `
          AND p.slice_id IN (SELECT o.slice_id FROM lens_member m JOIN partition o ON o.id = m.partition_id
                              WHERE m.lens_id = ?1${pending ? ' AND o.pending > 0' : ''})`
    : pending ? `
          AND p.slice_id IN (SELECT slice_id FROM partition WHERE pending > 0)`
      : '');

const PREPARED = new WeakMap<DatabaseSync, Record<string, StatementSync>>();
