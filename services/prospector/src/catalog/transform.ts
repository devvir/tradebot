import type { DatabaseSync } from 'node:sqlite';
import type { Transform } from '../types';

/**
 * The substitutions no pattern can express, held in memory and written from one
 * place.
 *
 * A pattern says `{TRANSFORM:kind:default}` where a venue puts something only a
 * table can answer. This is that table: **read on every generated key**, which
 * is thousands per series and tens of thousands of series, so it is loaded once
 * and answered from a map rather than queried.
 *
 * **Writes go through here too.** A row added behind this module's back is a row
 * generation keeps ignoring until something happens to reload, which looks
 * exactly like a venue that stopped serving a key.
 */

/** Every transform a venue holds, by the instrument it belongs to. */
const held = new WeakMap<DatabaseSync, Map<string, Transform[]>>();

/** One instrument's key in the map. A venue's markets are canonical, so this is unique. */
const identity = (venueId: number, market: string, symbol: string): string =>
  `${venueId} ${market.toLowerCase()} ${symbol}`;

/**
 * Load the table, once per database.
 *
 * Ordered so that a dataset named outright is met before the catch-all, which is
 * what makes "most specific wins" a property of the scan rather than of a sort
 * at every lookup.
 */
const registry = (db: DatabaseSync): Map<string, Transform[]> => {
  const had = held.get(db);

  if (had) return had;

  const map = new Map<string, Transform[]>();

  for (const row of db.prepare(
    `SELECT venue_id AS venueId, market, symbol, dataset, kind,
            transform, date_from AS from_, date_to AS to_
       FROM transform
       ORDER BY dataset DESC`,
  ).all() as unknown as Transform[]) {
    const at = identity(row.venueId, row.market, row.symbol);

    map.set(at, [...(map.get(at) ?? []), row]);
  }

  held.set(db, map);

  return map;
};

/** Warm the map, so the first key generated does not pay for the table. */
export const loadTransforms = (db: DatabaseSync): number => {
  let rows = 0;

  for (const list of registry(db).values()) rows += list.length;

  return rows;
};

/**
 * Everything one instrument substitutes, or undefined where it substitutes
 * nothing - which is almost every instrument of almost every venue.
 *
 * **Attached to a series when it is loaded**, so generating a key stays a pure
 * function of the row and needs no database in hand. Undefined rather than an
 * empty array, because a registry of hundreds of thousands of series pays for
 * every field that is not worth its bytes.
 */
export const transformsOf = (
  db:      DatabaseSync,
  venueId: number,
  market:  string,
  symbol:  string,
): Transform[] | undefined => registry(db).get(identity(venueId, market, symbol));

/**
 * What one instrument substitutes for a kind on a given date, or undefined to
 * leave the pattern's own default standing.
 *
 * `dataset` is matched exactly or by the catch-all, and the dates are inclusive
 * at whatever width the series stamps them — a monthly series asks with
 * `202609` and a daily one with `20260903`, and a row written at either width
 * compares correctly against both, since the stamps share a prefix.
 */
export const transformFor = (
  rows:    readonly Transform[] | undefined,
  dataset: string,
  kind:    string,
  at:      string,
): string | undefined => {
  if (rows === undefined) return undefined;

  for (const row of rows) {
    if (row.kind !== kind) continue;
    if (row.dataset !== '' && row.dataset !== dataset) continue;

    const width = Math.min(at.length, row.from_.length);

    if (at.slice(0, width) < row.from_.slice(0, width)) continue;

    if (row.to_ !== null) {
      const upper = Math.min(at.length, row.to_.length);

      if (at.slice(0, upper) > row.to_.slice(0, upper)) continue;
    }

    return row.transform;
  }

  return undefined;
};

/**
 * Record what an instrument substitutes, and make it true for the next key
 * generated rather than for the next process.
 *
 * **The venue is what discovers these.** Bitget reassigns a directory and says
 * so only through its own search endpoint, so a preamble that meets a moved
 * instrument writes the row here and generation follows immediately.
 */
export const addTransform = (db: DatabaseSync, row: Transform): void => {
  db.prepare(
    `INSERT INTO transform (venue_id, market, symbol, dataset, kind, transform, date_from, date_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (venue_id, market, symbol, dataset, kind, date_from)
     DO UPDATE SET transform = excluded.transform, date_to = excluded.date_to`,
  ).run(row.venueId, row.market, row.symbol, row.dataset, row.kind,
    row.transform, row.from_, row.to_);

  const map = registry(db);
  const at  = identity(row.venueId, row.market, row.symbol);
  const had = (map.get(at) ?? []).filter(one =>
    ! (one.kind === row.kind && one.dataset === row.dataset && one.from_ === row.from_));

  // Named datasets first, which is what makes the scan in `transformFor` return
  // the most specific row rather than whichever was written first.
  map.set(at, [...had, row].sort((a, b) => b.dataset.localeCompare(a.dataset)));
};
