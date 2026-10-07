import type { Series, Table } from './types';

/**
 * Which stocker version last changed what is written, at each level it can
 * change at.
 *
 * **A partition's revision moves when its archives do, or when one of these
 * does — and for no other reason.** How a partition is built is free to change
 * as long as what is built does not: its columns, their types, its rows and
 * their order. A change to any of those is said here, by hand, at the narrowest
 * level that covers it:
 *
 * - `EVERY` — every partition of the vault.
 * - `TABLES` — every partition of one canonical table.
 * - a series' own `version` — the partitions that entry of the map reads.
 *
 * Each is the stocker version the change shipped in, so it is never a value
 * used before. Only what has changed is listed: a table that is not here, and a
 * series without a `version`, are as they were first written.
 *
 * Restocking is the expensive consequence — a partition's archives may have
 * left the disk — so a level is bumped for a change to its output and never
 * for a change to the code that produces it.
 */

/** The stocker version in which what every partition holds last changed. */
export const EVERY = '1.0.0';

/** The stocker version in which what a table's partitions hold last changed. */
export const TABLES: Partial<Record<Table, string>> = {};

/**
 * Every version that says what a partition of this table holds, read by these
 * entries of the map, for one month (`YYYY-MM`): the vault's, the table's where
 * it has one, and that of each entry that holds for the month and has one.
 *
 * Only what is stated is answered, so an entry added to the map without a
 * version moves nothing.
 */
export const versionsOf = (table: Table, series: readonly Series[], month: string): string[] => [
  `every=${EVERY}`,
  ...(TABLES[table] ? [`table=${TABLES[table]}`] : []),
  ...series
    .filter(one => one.version && (! one.from || month >= one.from) && (! one.until || month < one.until))
    .map(one => `series=${one.version}`)
    .sort(),
];
