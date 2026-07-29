import { join } from 'node:path';
import config from './config';
import type { Candidate, PartitionKey } from './types';

/**
 * Where a partition lives, and what its file is called.
 *
 * Both are derived from the key alone, so the layout is described once and
 * every reader and writer agrees by construction.
 */

/**
 * Levels below `dataset=` that only some tables carry.
 *
 * **One list, read by everything.** The id, the label, the directory and the
 * file name all have to agree on which attributes distinguish a partition, and
 * spelling them out in four places is four chances to add the fifth attribute
 * to three of them. Adding a level here is the whole change.
 *
 * **Which levels a dataset carries is a property of the dataset, not of the
 * venue.** `klines` always carries `interval=`; `funding` always carries
 * `kind=`; `orderBook` always carries `variant=` — including for a venue that
 * publishes a single value, which then simply has one directory. Path depth
 * that varied by venue inside one table would make every reader and writer
 * branch on which venue it was looking at.
 */
const EXTRA: (keyof PartitionKey)[] = ['interval', 'variant', 'kind'];

/** The extras a key actually carries, in the one order they are ever written. */
const extrasOf = (key: PartitionKey): string[] =>
  EXTRA.flatMap(level => (key[level] ? [String(key[level])] : []));

/**
 * The letter a symbol is filed under, so a market holds a few dozen entries per
 * letter instead of thousands of symbol directories side by side.
 *
 * **A bare segment, not `key=value`**, because it is a filesystem device and
 * not a fact about the data — a query engine ignores it, and nothing should be
 * able to filter on it.
 *
 * Uppercased, so `allmargin` files beside `ADAUSDT` rather than in a bucket of
 * its own. Anything that is not a letter goes to `_`: symbols beginning with a
 * digit (`1INCHUSDT`, `10000SATSUSDT`) and the handful with CJK names
 * (`龙虾-USDT`). The point is bounded fan-out, not a faithful index.
 */
const bucket = (symbol: string): string => {
  const first = symbol.slice(0, 1).toUpperCase();

  return first >= 'A' && first <= 'Z' ? first : '_';
};

export const keyOf = (file: Candidate): PartitionKey => ({
  table:    file.series.table,
  venue:    file.series.venue,
  market:   file.series.market,
  symbol:   file.rawSymbol,
  interval: file.interval,
  variant:  file.series.variant,
  kind:     file.series.kind,
  month:    file.month,
});

/**
 * Stable identity of a partition: the grouping key and the ledger key.
 *
 * **The format is load-bearing and must not follow the layout around.** Every
 * recorded partition is found by this string — staleness is a lookup of it —
 * so changing it orphans the ledger, and a vault of built partitions reads as
 * unbuilt and is rebuilt from raw. Use `labelOf` for anything a person reads.
 */
export const idOf = (key: PartitionKey): string =>
  [key.table, key.venue, key.market, key.symbol, ...extrasOf(key), key.month]
    .filter(Boolean).join('|');

/**
 * How a partition is named in a log line.
 *
 * Reads in the order the vault is laid out, so a line in `docker logs` and a
 * path on disk say the same thing in the same sequence. The letter bucket is
 * left out: it is a filesystem device for bounding directory width, not part of
 * what a partition *is*.
 *
 * **The extras stay in.** htx publishes `markPrice` for one symbol-month at
 * seven intervals, each its own partition and its own file — a label without
 * them would give seven different things the same name, in precisely the log
 * somebody is reading to tell them apart.
 */
export const labelOf = (key: PartitionKey): string =>
  [key.venue, key.market, key.symbol, key.table, ...extrasOf(key), key.month]
    .filter(Boolean).join('|');

/**
 * `<vault>/venue=…/market=…/{FL}/symbol=…/dataset=…[/interval=…][/variant=…][/kind=…]`
 *
 * Hive-style `key=value` directories, so a query engine reads them back as
 * columns and prunes on them without the caller building a path. The order is
 * chosen for **handling rather than for querying**: an engine harvests
 * `key=value` from any position and prunes the same either way, so what the
 * order decides is what a single directory can be moved, backed up or evicted
 * as. Venue first makes a venue one folder.
 *
 * `dataset` rather than `table` because `table` is a SQL reserved word, and a
 * column named that has to be quoted in every query that mentions it.
 *
 * **The month is deliberately not a directory level.** It could be — and then
 * `date` would be a prunable column — but the only thing that buys is skipping
 * file *opens*: without it a time-range query on `ts` makes the engine read
 * each file's footer to see whether its row-group statistics fall in range.
 * A footer is a few KB at the tail of the file, no data is scanned, and a
 * symbol holds at most one file per month — 120 for ten years of history. That
 * is a few milliseconds, against one directory per symbol-month in inodes and
 * in every `find` over the vault.
 *
 * So a partition is one **file** in a symbol's directory, and the month lives
 * in its name. Scoping in time is `WHERE ts BETWEEN …`, which works because
 * every partition is written sorted by `ts` and no two overlap.
 */
export const dirOf = (key: PartitionKey): string => {
  const levels = [
    `venue=${key.venue}`,
    `market=${key.market}`,
    bucket(key.symbol),
    `symbol=${key.symbol}`,
    `dataset=${key.table}`,
    ...EXTRA.flatMap(level => (key[level] ? [`${level}=${key[level]}`] : [])),
  ];

  return join(config.vaultDir, ...levels);
};

/**
 * The path flattened, because a file that leaves the tree travels alone: an
 * upload queue or a transfer log shows the name and not the path, and a
 * thousand rows of `data.parquet` say nothing about what is moving.
 */
export const fileNameOf = (key: PartitionKey): string =>
  [key.table, key.venue, key.market, key.symbol, ...extrasOf(key),
    key.month.replace('-', '')]
    .filter(Boolean).join('.') + '.parquet';

export const pathOf = (key: PartitionKey): string =>
  join(dirOf(key), fileNameOf(key));
