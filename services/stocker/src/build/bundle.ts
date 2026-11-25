import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { q } from '../db';
import { fieldsOf } from '../schema/tables';
import { STAGED } from '../vault';
import { PARQUET, WHOLE, orderOf, stagedOf } from './shared';
import type { VaultKey } from '../types';

/**
 * Join a staged partition's files into the one file a small month is stored
 * as, and say where it is.
 *
 * **Appended, not sorted.** Each file is already in symbol and time order —
 * one instrument's, or a batch of them written together — so reading them in
 * symbol order and writing what is read gives a file ordered by symbol and then
 * by time, one instrument's rows together, which is how the file is read,
 * without holding a month in memory to sort it. A single file is the month
 * already, and is moved into place as it is. Only where two files hold symbols
 * that interleave — a big instrument read on its own, out of the middle of a
 * batch — is the join a sort.
 *
 * A partition every input of which was empty still becomes a file, with the
 * table's columns and no rows, so it reads as stocked rather than being rebuilt
 * every sweep.
 */
export const bundleStaged = async (conn: DuckDBConnection, key: VaultKey, staging: string): Promise<string> => {
  await mkdir(staging, { recursive: true });

  const out   = join(staging, '@.bundle');
  const names = (await readdir(staging)).filter(name => name.endsWith(STAGED)).map(name => name.slice(0, -STAGED.length));

  // One staged file — an instrument's, or a batch written whole — is the month's file as it stands.
  if (names.length === 1) {
    await rename(stagedOf(staging, names[0]!), out);

    return out;
  }

  const spans  = names.some(name => name.startsWith(WHOLE)) ? await spansOf(conn, names.map(name => stagedOf(staging, name))) : null;
  const staged = spans ? spans.map(span => q(span.path)) : names.sort().map(symbol => q(stagedOf(staging, symbol)));
  const sorted = spans !== null && spans.some((span, at) => at > 0 && span.first <= spans[at - 1]!.last);

  const rows = staged.length
    ? `SELECT * FROM read_parquet([${staged.join(', ')}])${sorted ? ` ORDER BY symbol, ${orderOf(key)}` : ''}`
    : `SELECT CAST(NULL AS VARCHAR) AS symbol, ${fieldsOf(key.table)
      .map(field => `CAST(NULL AS ${field.type}) AS ${field.name}`).join(', ')} WHERE false`;

  /**
   * Insertion order is what makes appending work, and it is off for the
   * instance — see `open`. It is turned on for this connection's session alone,
   * for this one statement, so what other connections build meanwhile keeps
   * spilling rather than holding its rows in order.
   */
  await conn.run('SET SESSION preserve_insertion_order=true');

  try {
    await conn.run(`COPY (${rows}) TO ${q(out)} ${PARQUET}`);
  } finally {
    await conn.run('RESET SESSION preserve_insertion_order');
  }

  return out;
};

/** The symbols each staged file holds, first and last, in the order of their first. */
const spansOf = async (
  conn:  DuckDBConnection,
  paths: string[],
): Promise<{ path: string; first: string; last: string }[]> =>
  (await conn.runAndReadAll(
    `SELECT filename, min(symbol), max(symbol) FROM read_parquet([${paths.map(q).join(', ')}], filename = true) GROUP BY 1`,
  )).getRows()
    .map(row => ({ path: String(row[0]), first: String(row[1]), last: String(row[2]) }))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
