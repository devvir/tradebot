import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import config from '../config';
import { open, q } from '../db';
import { idOf, neighbourOf } from '../keys';
import { partitionOf, read, record } from '../ledger';
import { extrasOf, seriesOf } from '../schema/series';
import { fieldsOf } from '../schema/tables';
import { reachOf } from '../spill';
import { Slices, fileOf, revisionOf } from '../vault';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Edge, Entry, Partition, PartitionKey, Side, VaultKey } from '../types';

/**
 * One-off: take what a neighbouring month held of each stocked month out of the
 * month's own files and put it beside them.
 *
 * Until now a month and the hours its neighbour held of it were stocked into
 * one file. They are stocked apart from here on, and the months already in the
 * vault are brought to that layout by cutting each file in two at the time the
 * neighbour's first file begins — no archive is read.
 *
 * **Run with stocker stopped**, and with `--write` to do it; without, it says
 * what it would do. A month is left alone, and named, where its ledger line
 * cannot be reproduced from what the line says: then cutting it would be a
 * guess about what it holds.
 */
const main = async (): Promise<void> => {
  const write   = process.argv.includes('--write');
  const entries = [...(await read()).values()].filter(one => one.preVersion !== '' || one.postVersion !== '');
  const slices  = new Slices();
  const { conns, close } = await open();
  const conn = conns[0]!;

  let done = 0, files = 0, bytes = 0;
  const skipped: string[] = [];

  await conn.run('SET preserve_insertion_order=true');

  for (const entry of entries) {
    const plan = planOf(entry);

    if (typeof plan === 'string') {
      skipped.push(`${entry.partition}: ${plan}`);

      continue;
    }

    const dir   = join(config.vaultDir, dirname(entry.partition));
    const month = basename(entry.partition);
    const held  = (await slices.at(dir)).get(month)?.get(entry.revision);
    const begun = (await slices.at(dir)).get(month)?.get(plan.revision);

    // Nothing at the old revision and nothing at the new: the vault does not hold it. All at the new: done before.
    if (! held && ! begun) {
      skipped.push(`${entry.partition}: its files are not in the vault at the ledger's revision`);

      continue;
    }

    const symbols = held ? (held.bundle ? ['@'] : held.symbols) : [];

    done++;
    files += symbols.length;
    bytes += entry.size;

    if (! write) continue;

    for (const symbol of symbols) {
      const from = fileOf(plan.key, entry.revision, symbol);

      await copy(conn, from, fileOf(plan.key, plan.revision, symbol), `ts >= ${plan.start + plan.pre} AND ts < ${plan.end - plan.post}`);

      for (const [side, where] of [
        ['pre', `ts < ${plan.start + plan.pre}`], ['post', `ts >= ${plan.end - plan.post}`],
      ] as [Side, string][]) {
        if (! plan.sides.includes(side)) continue;

        const out = fileOf(plan.key, plan.revision, symbol, side);

        if (await copy(conn, from, out, where) === 0) await rm(out, { force: true });
      }

      // Only once its two parts are written: stopped here, the file is still whole and is cut again on the next run.
      await rm(from);
    }

    /**
     * Written down from what is in the vault now, not from what this run did:
     * a run stopped part way through a month finds some of its files already
     * cut, and the line has to count them all.
     */
    const after = (await new Slices().at(dir)).get(month)?.get(plan.revision);

    if (! after) throw new Error(`${entry.partition}: nothing at ${plan.revision} after cutting it`);

    await record(plan.key, plan.source, plan.edges, [], plan.revision, after);

    if (done % 20 === 0) console.log(`  ${done} done · ${(bytes / 1e9).toFixed(1)} GB`);
  }

  close();

  console.log(`${write ? 'Converted' : 'Would convert'} ${done} partitions · ${files} files · ${(bytes / 1e9).toFixed(2)} GB`);
  console.log(`Left alone: ${skipped.length}`);

  for (const line of skipped.slice(0, 40)) console.log(`  ${line}`);
};

/** Write the rows of a file that a condition keeps to another, in the order they are in. Returns how many. */
const copy = async (conn: DuckDBConnection, from: string, to: string, where: string): Promise<number> => {
  await conn.run(
    `COPY (SELECT * FROM read_parquet(${q(from)}) WHERE ${where})
     TO ${q(to)} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`);

  return Number((await conn.runAndReadAll(`SELECT count(*) FROM read_parquet(${q(to)})`)).getRows()[0]![0]);
};

/**
 * Everything a ledger line says of a month, rebuilt: its place in the vault,
 * what it was stocked from, the neighbours it read, the revision it gets — or
 * why it cannot be.
 */
const planOf = (entry: Entry): string | {
  key: VaultKey; source: Partition; edges: Edge[]; sides: Side[]; revision: string;
  start: number; end: number; pre: number; post: number;
} => {
  const month  = `${entry.month.slice(0, 4)}-${entry.month.slice(4)}`;
  const source = {
    venue: entry.venue, market: entry.market, dataset: entry.dataset, variant: entry.variant,
    grain: entry.grain, bundle: entry.bundle, month,
  } as PartitionKey;

  const series = seriesOf(source);

  if (series.length === 0 || ! series[0]!.spill) return 'no spilling series reads it';

  const first = series[0]!;
  const key: VaultKey = { table: first.table, venue: entry.venue, market: source.market, ...extrasOf(first, entry.variant), month };

  if (partitionOf(key) !== entry.partition) return `it would land at ${partitionOf(key)}`;

  const partition = { key: source, id: idOf(source), version: entry.version } as Partition;
  const edges: Edge[] = [];

  for (const { by, side } of reachOf(first.spill)) {
    const end: Side = by > 0 ? 'post' : 'pre';
    const version   = end === 'post' ? entry.postVersion : entry.preVersion;

    if (! version || version === 'missing') return `its ${end} side is ${version || 'not named'}`;

    const beside = neighbourOf(source, by);

    edges.push({ partition: { key: beside, id: idOf(beside), version } as Partition, side, end });
  }

  // The revision the line names, computed as it was computed when the line was written.
  const hash = createHash('sha256');

  hash.update('2\n');
  hash.update(JSON.stringify(fieldsOf(key.table)));
  hash.update(JSON.stringify(series));
  hash.update(`${partition.id}\n${partition.version}\n`);

  for (const edge of edges) hash.update(`${edge.partition.id}\n${edge.side}\n${edge.partition.version}\n`);

  if (hash.digest('hex').slice(0, 12) !== entry.revision) return 'its revision is not the one its line would compute';

  /**
   * How far from UTC midnight the venue cuts: bybit's MetaTrader files are
   * UTC+3 months; bitget, okx and htx cut at 16:00 UTC, midnight UTC+8.
   */
  const hours = first.utcOffsetHours ?? (['bitget', 'okx', 'htx'].includes(entry.venue) ? 8 : null);

  if (hours === null) return 'how far from UTC midnight it cuts is not known';

  const [year, index] = month.split('-').map(Number) as [number, number];
  const micros = hours * 3_600_000_000;
  const sides  = edges.map(edge => edge.end);

  return {
    key, source: partition, edges, sides, revision: revisionOf(key, partition, series, edges),
    start: Date.UTC(year, index - 1, 1) * 1000, end: Date.UTC(year, index, 1) * 1000,
    pre: sides.includes('pre') ? micros : 0, post: sides.includes('post') ? micros : 0,
  };
};


main().catch((err) => { console.error(err); process.exit(1); });
