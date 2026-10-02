import type { DatabaseSync } from 'node:sqlite';
import type { MonthState, MonthTotals, QueryStatements, Series, SeriesFilter, VenueRow, VenueTotals } from './types';

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

/** Every venue's totals, summed over its hosts, off the venue rollup. */
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
       FROM venue v LEFT JOIN rollup_venue m ON m.venue_id = v.id
      GROUP BY v.name
      ORDER BY v.name`,
  ).all() as unknown as VenueTotals[];

/** A venue's months between two bounds, off the venue rollup, with the state each is in. */
export const monthTotals = (
  db:       DatabaseSync,
  venueIds: readonly number[],
  opts:     { from?: string; to?: string } = {},
): MonthTotals[] => {
  if (venueIds.length === 0) return [];

  const rows = db.prepare(
    `SELECT month,
            SUM(files)         AS files,
            SUM(bytes)         AS bytes,
            SUM(pending)       AS pending,
            SUM(pending_bytes) AS pendingBytes,
            SUM(withdrawn)     AS withdrawn
       FROM rollup_venue
      WHERE venue_id IN (${venueIds.map(() => '?').join(',')})
        AND (? IS NULL OR month >= ?)
        AND (? IS NULL OR month <= ?)
      GROUP BY month
      ORDER BY month`,
  ).all(...venueIds, opts.from ?? null, opts.from ?? '', opts.to ?? null, opts.to ?? '') as unknown as
    Omit<MonthTotals, 'state'>[];

  return rows.map(row => ({ ...row, state: (row.pending > 0 ? 'open' : 'closed') as MonthState }));
};

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
        `SELECT s.id, p.venue_id AS venueId, s.symbol, s.url_symbol AS urlSymbol,
                p.market, p.dataset, p.variant, p.pattern, p.grain,
                s.first, s.last, p.retired_at AS retiredAt
           FROM pattern p JOIN series s ON s.pattern_id = p.id
          WHERE p.venue_id = ?
          ORDER BY s.id`),
    };

    PREPARED.set(db, held);
  }

  return held;
};

const PREPARED = new WeakMap<DatabaseSync, QueryStatements>();
