import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { ParkingBuffer, SeriesRegistry, Transform } from '../types';

/**
 * What the catalog holds in memory for one open database, in one place.
 *
 * **Per database rather than per process**: a service opens one catalog and the
 * tests open several, and what is held describes the database it was read from —
 * venue and series ids repeat across catalogs, so a figure held for the process
 * would be quietly wrong about the next one opened. Keyed on the handle, so
 * nothing has to be threaded through callers, and released with it.
 *
 * Only the holding is done here: what each field means, and when it changes,
 * is said where it is kept.
 */
export interface CatalogMemory {
  /** Statements prepared once and reused, keyed by their SQL — see `statement`. */
  readonly statements: Map<string, StatementSync>;

  /** The series and patterns, once loaded. */
  series: SeriesRegistry | null;

  /** Every transform, by the instrument it belongs to, once loaded. */
  transforms: Map<string, Transform[]> | null;

  /** Rows outstanding in the backlog per venue, each seeded on first ask. */
  readonly parked: Map<number, number>;

  /** Keys waiting to be parked together. */
  readonly parking: ParkingBuffer;

  /**
   * Where the withdrawals log is written: null for a database that is not a
   * file, and undefined until first asked.
   */
  withdrawalsLog: string | null | undefined;
}

/** What is held for this database, made empty on first ask. */
export const inMemory = (db: DatabaseSync): CatalogMemory => {
  let held = MEMORY.get(db);

  if (! held) MEMORY.set(db, held = {
    statements:     new Map(),
    series:         null,
    transforms:     null,
    parked:         new Map(),
    parking:        { rows: [], waiting: [], timer: null },
    withdrawalsLog: undefined,
  });

  return held;
};

/**
 * A statement prepared once per database and reused, keyed by its SQL.
 *
 * **For the statements on a per-row path**, where preparing the same SQL for
 * every row is most of what the row costs. A statement is reset after each
 * `run`, `get` or `all`, so one handle serves every caller in turn; one read
 * with `iterate` stays open until the read ends, and is prepared on its own.
 */
export const statement = (db: DatabaseSync, sql: string): StatementSync => {
  const { statements } = inMemory(db);

  let one = statements.get(sql);

  if (! one) statements.set(sql, one = db.prepare(sql));

  return one;
};

const MEMORY = new WeakMap<DatabaseSync, CatalogMemory>();
