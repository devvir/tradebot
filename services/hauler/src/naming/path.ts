import { join } from 'node:path';
import { DATASETS, MARKETS } from '../types';
import type { Market, Named, Offered, Partition } from '../types';

/**
 * Where a file lives, and what it is called once it is there.
 *
 * **The full identity is in the filename**, which is what lets a reader ignore
 * the directories entirely: list the files, parse the names, never learn where
 * they live. The hierarchy above them is for narrowing a search and for being
 * able to *look* at the archive — a flat directory of seventy million files can
 * be neither browsed nor listed in part.
 *
 * ```
 * <archives>/venue/market/dataset/YYYYMM/FL/symbol/
 *     venue|market|dataset|symbol|period[|part].ext
 * ```
 *
 * **Positional, not `key=value`.** The vault is read by a query engine that
 * harvests `key=value` from wherever it appears; the archives are read by code
 * that knows the shape. So a level means what its position says it means, and
 * the depth never varies.
 */

/**
 * The canonical identity of an offered file.
 *
 * **Nothing is translated here, because nothing needs to be.** The catalog
 * speaks the vocabulary the archives are arranged by, so a name is the fields it
 * hands over, put in order. What used to sit here — a table of every venue's
 * habits, its own spellings and its own trees — belongs to prospector's adapters
 * and stops there.
 *
 * What is left is the one thing a consumer of that vocabulary still owes: it
 * checks. A value outside the vocabulary, or a file the catalog could not place
 * at all, is **refused by name** rather than given a plausible one — an invented
 * name becomes a directory, and a directory becomes something a reader trusts.
 */
export const nameOf = (file: Offered): Named => ({
  venue:   file.venue,
  market:  marketOf(file),
  dataset: datasetOf(file),
  symbol:  symbolOf(file),
  period:  file.date,
  ...(file.part === undefined ? {} : { part: file.part }),
  ext:     file.ext,
});

/** The file's path, below whichever directory the archives are rooted at. */
export const pathOf = (root: string, named: Named): string =>
  join(root, ...directoriesOf(named), filenameOf(named));

/**
 * The partition a file belongs to: `venue + market + dataset + month`.
 *
 * The unit everything downstream works in. Hauler completes one, stocker
 * imports one, cold storage evicts and restores one — and because the month is
 * a level rather than a part of a filename, a partition is exactly one
 * directory, matched without a walk and moved with one rename.
 */
export const partitionOf = (named: Named): Partition => ({
  venue:   named.venue,
  market:  named.market,
  dataset: named.dataset,
  month:   monthOf(named.period),
});

/** A partition's directory, which is the whole of it and nothing else. */
export const partitionPath = (root: string, partition: Partition): string =>
  join(root, partition.venue, partition.market, partition.dataset, partition.month);

/**
 * `venue|market|dataset|symbol|period[|part].ext`
 *
 * `|` separates the fields and `,` the variants inside the dataset. Measured
 * across every symbol in the catalog, neither character occurs in any of them —
 * which is the only property that matters. Bitget's symbols do contain `$`, so
 * these names need quoting in a shell whatever the separator.
 */
export const filenameOf = (named: Named): string => {
  const fields = [named.venue, named.market, named.dataset, named.symbol, named.period];

  if (named.part !== undefined) fields.push(named.part);

  return `${fields.join('|')}${named.ext}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * The directory a symbol sits under: its first letter, uppercased.
 *
 * A filesystem device and not a fact about the data, so it is a bare level
 * rather than a labelled one. It exists because a few dozen directories per
 * letter reads and lists in a way that several thousand side by side does not.
 */
const firstLetterOf = (symbol: string): string => {
  const first = symbol.slice(0, 1).toUpperCase();

  return /^[A-Z]$/.test(first) ? first : '_';
};

const directoriesOf = (named: Named): string[] => [
  named.venue,
  named.market,
  named.dataset,
  monthOf(named.period),
  firstLetterOf(named.symbol),
  named.symbol,
];

/**
 * **The period's own length carries its grain** — `202506` is a month,
 * `20250601` a day, `2025060113` an hour — so nothing else has to say which,
 * and the month a period belongs to is its first six characters whatever the
 * grain.
 */
const monthOf = (period: string): string => {
  if (period.length < 6)
    throw new Error(`A period of '${period}' names no month — expected yyyymm or finer`);

  return period.slice(0, 6);
};

/** The canonical market, checked against the vocabulary rather than trusted. */
const marketOf = (file: Offered): Market => {
  if (! (MARKETS as readonly string[]).includes(file.market))
    throw new Error(
      `'${file.market}' is not a market hauler knows (${file.venue} ${file.dataset}). ` +
      `The catalog is expected to answer in canonical terms — one of ${MARKETS.join(', ')}.`);

  return file.market as Market;
};

/**
 * The dataset with its variants, comma-separated — `klines,1m`,
 * `books,400,incremental`.
 *
 * **Which levels a dataset carries is a property of the dataset, never of the
 * venue**, and the catalog already resolved them into one string. A venue
 * publishing a single book depth or a single bar length still lands under a
 * directory naming it: path depth that varied by venue would make every reader
 * branch on which venue it was looking at, and a level that is merely absent
 * reads as a different partition rather than as the same one.
 */
const datasetOf = (file: Offered): string => {
  if (! (DATASETS as readonly string[]).includes(file.dataset))
    throw new Error(
      `'${file.dataset}' is not a dataset hauler knows (${file.venue} ${file.market}). ` +
      'The catalog is expected to answer in canonical terms — see DATASETS in types.ts.');

  const levels = Object.values(file.variant ?? {});

  /**
   * **Joined in the order the catalog named them**, which is the order the
   * levels belong in — depth before mode, never the other way round. Sorting
   * them here, or trusting a caller to, would rename directories on a whim.
   */
  return levels.length > 0 ? [file.dataset, ...levels].join(',') : file.dataset;
};

/**
 * The instrument, or the bucket symbol where one file carries every instrument.
 *
 * **An empty symbol is not the bucket.** The catalog spells the bucket `@` — a
 * character no venue uses in an instrument name, so it can never collide with a
 * real one — and answers blank only where it could not place the file in a
 * series at all. Naming that `@` would file an unidentified file among the ones
 * that genuinely carry everything, which is a lie a reader cannot detect.
 */
const symbolOf = (file: Offered): string => {
  if (file.symbol === '')
    throw new Error(
      `${file.venue} ${file.market}/${file.dataset} ${file.date} has no symbol — ` +
      'the catalog could not place it in a series, so it has no name to be filed under.');

  return file.symbol;
};

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_firstLetterOf = firstLetterOf;
export const _test_monthOf       = monthOf;
