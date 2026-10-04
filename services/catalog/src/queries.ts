import type { DatabaseSync } from 'node:sqlite';
import type { QueryStatements, Series, SeriesFilter, VenueRow, VenueTotals } from './types';

/**
 * The reads every part of the catalog shares, straight off the tables
 * prospector keeps.
 *
 * **Plain queries, one exception.** The collector rewrites these tables
 * continuously, so a read is answered from what they say at that moment —
 * except a venue's series, see `seriesFor`.
 */

/** Every venue, by name, with the host and address it is served from. */
export const venues = (db: DatabaseSync): VenueRow[] =>
  db.prepare('SELECT name, host, base, key_root AS keyRoot FROM venue ORDER BY id').all() as unknown as VenueRow[];

/** The ids a venue is served under — more than one where it publishes from several hosts. */
export const venueIds = (db: DatabaseSync, name: string): number[] =>
  (db.prepare('SELECT id FROM venue WHERE name = ? ORDER BY host').all(name) as { id: number }[])
    .map(row => row.id);

/**
 * A venue's series, as the catalog reads them, narrowed by any of the filter's
 * fields. Absent means any; an explicit empty `symbols` asks for none.
 *
 * **Held for `SERIES_MS`.** Every view folds a venue's series — contents, lens
 * options, sizes, checks, scopes — and gate alone has a hundred thousand, which
 * took a second to read each time, so one page of the lens editor read the whole
 * registry several times over. The registry changes when a survey finds an
 * instrument, so a minute old is as current as the lens scope built from it.
 * The rows are frozen: they are shared by every caller until they are dropped.
 */
export const seriesFor = (db: DatabaseSync, venueId: number, only?: SeriesFilter): Series[] => {
  const symbols = only?.symbols?.map(one => one.toLowerCase());

  return heldSeries(db, venueId).filter(row =>
    (! only?.live      || row.retiredAt === null)
    && (! only?.symbol  || row.symbol === only.symbol)
    && (! symbols       || symbols.includes(row.symbol.toLowerCase()))
    && (! only?.market  || same(row.market, only.market))
    && (! only?.dataset || same(row.dataset, only.dataset))
    && (! only?.variant || same(row.variant, only.variant))
    && (! only?.grain   || row.grain === only.grain));
};

/** Every venue's totals, summed over its partitions. */
export const venueTotals = (db: DatabaseSync): VenueTotals[] =>
  db.prepare(
    `SELECT v.name                                              AS venue,
            MIN(CASE WHEN m.files > 0 THEN m.month END)          AS firstMonth,
            MAX(CASE WHEN m.files > 0 THEN m.month END)          AS lastMonth,
            COALESCE(SUM(m.files), 0)                            AS files,
            COALESCE(SUM(m.bytes), 0)                            AS bytes,
            COALESCE(SUM(m.pending), 0)                          AS pending,
            COALESCE(SUM(m.pending_bytes), 0)                    AS pendingBytes,
            COALESCE(SUM(m.withdrawn), 0)                        AS withdrawn
       FROM (SELECT DISTINCT name FROM venue) v
       LEFT JOIN slice c     ON c.venue = v.name
       LEFT JOIN partition m ON m.slice_id = c.id
      GROUP BY v.name
      ORDER BY v.name`,
  ).all() as unknown as VenueTotals[];

// ── Internals ─────────────────────────────────────────────────────────────────

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** How long a venue's series are held before they are read again. */
const SERIES_MS = 60_000;

const SERIES = new WeakMap<DatabaseSync, Map<number, { at: number; rows: readonly Series[] }>>();

const heldSeries = (db: DatabaseSync, venueId: number): readonly Series[] => {
  let byVenue = SERIES.get(db);

  if (! byVenue) {
    byVenue = new Map();
    SERIES.set(db, byVenue);
  }

  const held = byVenue.get(venueId);

  if (held && Date.now() - held.at < SERIES_MS) return held.rows;

  const rows = Object.freeze((statements(db).series.all(venueId) as unknown as Series[])
    .map(row => Object.freeze(row)));

  byVenue.set(venueId, { at: Date.now(), rows });

  return rows;
};

/** Prepared once per database: a venue's series is the hot read of every view. */
const statements = (db: DatabaseSync): QueryStatements => {
  let held = PREPARED.get(db);

  if (! held) {
    held = {
      series: db.prepare(
        `SELECT s.id, p.venue_id AS venueId, p.slice_id AS sliceId,
                COALESCE(i.symbol, '@') AS symbol, s.url_symbol AS urlSymbol,
                c.market, c.dataset, c.variant, p.pattern, c.grain,
                s.first, s.last, p.retired_at AS retiredAt
           FROM pattern p JOIN slice c ON c.id = p.slice_id
           JOIN series s ON s.pattern_id = p.id
           LEFT JOIN instrument i ON i.id = s.instrument_id
          WHERE p.venue_id = ?
          ORDER BY s.id`),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, QueryStatements>();
