import type { ArchiveFile, Bundle, Grain, Market, PartitionKey } from './types';

/**
 * Reading the catalog's canonical key, which is also the file's path in the
 * archives:
 *
 *     venue/market/dataset[,variant]/FL/symbol/YYYYMM/venue|market|dataset[,variant]|symbol|date[.partNN].ext
 *     venue/market/dataset[,variant]/@/YYYYMM/venue|market|dataset[,variant]|@|date[.partNN].ext
 *
 * The name carries the whole identity, so it is the only part read; the
 * directories are for people and for narrowing. Everything a partition is —
 * venue, market, dataset, variant, bundle, grain, month — comes out of it, and
 * nothing about where the venue keeps the file.
 */

/**
 * The file a key names, or null for a name that is not a canonical file — a
 * download in progress, a backup, anything else that can sit in a directory.
 */
export const parseKey = (key: string): ArchiveFile | null => {
  const slash = key.lastIndexOf('/');
  const name  = key.slice(slash + 1);
  const parts = name.split('|');

  if (parts.length !== 5) return null;

  const [venue, market, descriptor, symbol, tail] = parts as [string, string, string, string, string];
  const match = TAIL.exec(tail);

  if (! match) return null;

  const [, date, part, ext] = match as unknown as [string, string, string | undefined, string];
  const grain     = GRAINS[date.length];
  const container = CONTAINERS[ext];

  if (! grain || ! container) return null;

  const comma = descriptor.indexOf(',');

  return {
    key,
    venue,
    market:   market as Market,
    dataset:  comma < 0 ? descriptor : descriptor.slice(0, comma),
    variant:  comma < 0 ? '' : descriptor.slice(comma + 1),
    bundle:   symbol === '@' ? 'market' : 'instrument',
    symbol,
    month:    `${date.slice(0, 4)}-${date.slice(4, 6)}`,
    date,
    grain,
    part:     part ?? null,
    container,
  };
};

/** The partition a file belongs to. */
export const partitionOf = (file: ArchiveFile): PartitionKey => ({
  venue:   file.venue,
  market:  file.market,
  dataset: file.dataset,
  variant: file.variant,
  bundle:  file.bundle,
  grain:   file.grain,
  month:   file.month,
});

/** A partition's identity as one string, for maps and logs. */
export const idOf = (key: PartitionKey): string =>
  [key.venue, key.market, descriptorOf(key), bundleMark(key.bundle), key.grain, key.month].join('|');

/** `dataset` or `dataset,variant`, as keys and directories write it. */
export const descriptorOf = (key: { dataset: string; variant: string }): string =>
  key.variant ? `${key.dataset},${key.variant}` : key.dataset;

/** The directory holding a dataset's files in the archives, relative to its root. */
export const datasetDirOf = (key: { venue: string; market: string; dataset: string; variant: string }): string =>
  [key.venue, key.market, descriptorOf(key)].join('/');

/** The same partition one month earlier or later. */
export const neighbourOf = (key: PartitionKey, by: number): PartitionKey => ({
  ...key, month: monthShift(key.month, by),
});

/** A `YYYY-MM` shifted by whole months, negative for earlier. */
export const monthShift = (month: string, by: number): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];

  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
};

/**
 * Whether a file is in the first or last period of its month — the files a
 * neighbouring month's spill reaches into. A monthly file is both.
 */
export const edgesOf = (file: ArchiveFile): { first: boolean; last: boolean } => {
  if (file.grain === 'monthly') return { first: true, last: true };

  const day = file.date.slice(6, 8);

  return { first: day === '01', last: day === lastDayOf(file.month) };
};

/** The last day of a `YYYY-MM`, as two digits. */
export const lastDayOf = (month: string): string => {
  const [year, index] = month.split('-').map(Number) as [number, number];

  return String(new Date(Date.UTC(year, index, 0)).getUTCDate()).padStart(2, '0');
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** `date[.partNN].ext` — the date's length is the grain. */
const TAIL = /^(\d{6}|\d{8}|\d{10}|\d{12})(?:\.part(\d+))?\.(zip|csv\.gz|tar\.gz|gz|csv|data\.zip)$/;

const GRAINS: Record<number, Grain> = { 6: 'monthly', 8: 'daily', 10: 'hourly', 12: 'minutely' };

/** What wraps the bytes, from the extension. */
const CONTAINERS: Record<string, string> = {
  'zip':      'zip',
  'data.zip': 'zip',
  'csv.gz':   'gzip',
  'gz':       'gzip',
  'tar.gz':   'tar.gz',
  'csv':      'plain',
};

const bundleMark = (bundle: Bundle): string => (bundle === 'market' ? '@' : '*');
