import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import config from './config';
import { SCRATCH } from './containers';
import { freeGb } from './vault';

/**
 * Resource-capped DuckDB connections — one per concurrent build, **all on one
 * instance**.
 *
 * The caps are not tuning, they are a guard: this machine runs collectors and
 * other heavy jobs at the same time, and an unbounded sort over a month of tick
 * data will happily take the box down. With `temp_directory` set, DuckDB spills
 * to disk instead of failing or being killed — under `<vault>/.stocker-tmp`,
 * with everything else transient, and capped so that it never takes the vault's
 * volume under `STOCKER_MIN_FREE_GB`: see `capSpill`.
 *
 * **Memory is capped here too.** Left alone the engine takes most of the
 * machine's memory before it spills, and one sort over a busy month is enough
 * to starve everything else running beside it.
 *
 * One instance is the load-bearing part. `threads` is instance-wide, so
 * connections sharing an instance share the cap — while a second instance would
 * bring caps of its own, and the guard would double every time the concurrency
 * did. Concurrent builds therefore divide the same budget, they never multiply
 * it.
 */
export const open = async (): Promise<{ conns: DuckDBConnection[]; close: () => void }> => {
  const spill = join(config.vaultDir, SCRATCH, SPILL);

  await mkdir(spill, { recursive: true });

  const instance = await DuckDBInstance.create();
  const first    = await instance.connect();

  await first.run(`SET threads=${config.threads}`);
  await first.run(`SET memory_limit='${config.memoryGb}GB'`);
  await first.run(`SET temp_directory=${q(spill)}`);
  await capSpill(first);

  /**
   * Without this a month of a busy symbol runs out of memory rather than
   * spilling — 0GUSDT perpetuals are ~300 MB gzipped per month, and the build
   * died at DuckDB's own memory ceiling with the spill directory still empty.
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

/**
 * Hold the engine's spill to what the vault's volume can give it: its free space
 * as it is now, less `STOCKER_MIN_FREE_GB`, and never under 1 GB.
 *
 * The cap is instance-wide. It is set as the engine is opened and again before each
 * sweep, when nothing is spilled, so it follows the volume as the vault fills.
 * A build that would spill past it fails, as a build that runs out of room does.
 */
export const capSpill = async (conn: DuckDBConnection): Promise<void> => {
  const gb = Math.max(1, Math.floor(await freeGb() - config.minFreeGb));

  await conn.run(`SET max_temp_directory_size='${gb}GB'`);
};

/** Under scratch: where the engine spills. */
const SPILL = 'engine';

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
