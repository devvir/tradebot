import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { q } from '../db';
import { STAGED } from '../vault';
import { PARQUET, nextSequence, orderOf } from './shared';
import type { Side, VaultKey } from '../types';

/**
 * Take out of a side's staged files the rows the month's own files already
 * hold, and say how many went.
 *
 * **A bar is one row, in one file.** What a neighbouring month holds of this
 * one is meant to begin where the month's own rows end — and a venue's files
 * do not always cut that cleanly: a month's file can carry the first bar of the
 * next, which the next month's file carries too. Each instrument's side is held
 * to the times its own rows do not reach: after its last for `post`, before its
 * first for `pre`. The month's own files are what is in the vault and are never
 * rewritten for it; an instrument's side left with nothing has no file.
 *
 * `own` are the month's own files: one of every instrument, or a file each.
 */
export const dropOverlap = async (
  conn: DuckDBConnection,
  key:  VaultKey,
  dir:  string,
  side: Side,
  own:  readonly string[],
): Promise<number> => {
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith(STAGED));

  if (names.length === 0 || own.length === 0) return 0;

  const reach = new Map((await conn.runAndReadAll(
    `SELECT symbol, min(ts), max(ts) FROM read_parquet([${own.map(q).join(', ')}]) GROUP BY 1`,
  )).getRows().map(row => [String(row[0]), { first: String(row[1]), last: String(row[2]) }] as const));

  let dropped = 0;

  for (const name of names) {
    const held = reach.get(name.slice(0, -STAGED.length));

    if (! held) continue;

    const file  = join(dir, name);
    const clear = side === 'post' ? `ts > ${held.last}` : `ts < ${held.first}`;

    const [over, all] = (await conn.runAndReadAll(
      `SELECT count(*) FILTER (WHERE NOT (${clear})), count(*) FROM read_parquet(${q(file)})`,
    )).getRows()[0]!.map(Number) as [number, number];

    if (over === 0) continue;

    dropped += over;

    if (over === all) {
      await rm(file, { force: true });

      continue;
    }

    const temp = `${file}.${nextSequence()}.tmp`;

    await conn.run(
      `COPY (SELECT * FROM read_parquet(${q(file)}) WHERE ${clear} ORDER BY ${orderOf(key)})
       TO ${q(temp)} ${PARQUET}`,
    );

    await rename(temp, file);
  }

  return dropped;
};
