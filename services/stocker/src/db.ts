import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import config from './config';

/**
 * Resource-capped DuckDB connections — one per concurrent build, **all on one
 * instance**.
 *
 * The caps are not tuning, they are a guard: this machine runs collectors and
 * other heavy jobs at the same time, and an unbounded sort over a month of tick
 * data will happily take the box down. With `temp_directory` set, DuckDB spills
 * to disk instead of failing or being killed.
 *
 * One instance is the load-bearing part. `memory_limit` and `threads` are
 * instance-wide, so connections sharing an instance share the caps — while a
 * second instance would bring caps of its own, and the guard would double
 * every time the concurrency did. Concurrent builds therefore divide the same
 * budget, they never multiply it.
 */
export const open = async (): Promise<{ conns: DuckDBConnection[]; close: () => void }> => {
  const spill = join(config.vaultDir, '.duckdb-tmp');

  await mkdir(spill, { recursive: true });

  const instance = await DuckDBInstance.create();
  const first    = await instance.connect();

  await first.run(`SET threads=${config.threads}`);
  await first.run(`SET memory_limit='${config.memoryLimit}'`);
  await first.run(`SET temp_directory='${spill}'`);

  /**
   * Without this a month of a busy symbol runs out of memory rather than
   * spilling — 0GUSDT perpetuals are ~300 MB gzipped per month, and the build
   * died at the memory limit with the spill directory still empty.
   *
   * The setting governs only the order of results that carry **no** `ORDER BY`.
   * Every partition is written by one, so the sortedness the layout depends on
   * is unaffected; what it gives up is preserving the scan order of a month's
   * files as they feed that sort, which is the part being buffered.
   */
  await first.run(`SET preserve_insertion_order=false`);

  const conns = [first];

  while (conns.length < config.concurrency) conns.push(await instance.connect());

  return { conns, close: () => conns.forEach(conn => conn.closeSync()) };
};

/** Row count straight from the Parquet footers — no data scan. */
export const countRows = async (conn: DuckDBConnection, glob: string): Promise<number> => {
  const reader = await conn.runAndReadAll(
    `SELECT count(*) AS n FROM read_parquet('${glob}')`);

  return Number(reader.getRows()[0]![0]);
};

/**
 * Single-quote a value for inline SQL.
 *
 * Paths and identifiers here come from the filesystem and from the series map,
 * never from user input, but a symbol with an apostrophe would still corrupt a
 * statement — and silently, since it would most likely parse.
 */
export const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
