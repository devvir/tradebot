import type { Grain, PartitionKey } from './types';

/**
 * Reading the canonical name every archive file carries:
 *
 *     venue|market|dataset[,variant]|symbol|date[.partNN].ext
 *
 * The name carries the whole identity, so it is the only part read. Which
 * partition a file belongs to — venue, market, dataset, variant, bundle, grain
 * and month — comes out of it and nothing else.
 */

/** The partition a file belongs to, or null for a name that is not a canonical file. */
export const partitionOf = (file: string): PartitionKey | null => {
  const parts = file.slice(file.lastIndexOf('/') + 1).split('|');

  if (parts.length !== 5) return null;

  const [venue, market, descriptor, symbol, tail] = parts as [string, string, string, string, string];
  const date  = TAIL.exec(tail)?.[1];
  const grain = date ? GRAINS[date.length] : undefined;

  if (! date || ! grain) return null;

  const comma = descriptor.indexOf(',');

  return {
    venue,
    market,
    dataset: comma < 0 ? descriptor : descriptor.slice(0, comma),
    variant: comma < 0 ? '' : descriptor.slice(comma + 1),
    grain,
    bundle:  symbol === '@' ? 'market' : 'instrument',
    month:   date.slice(0, 6),
  };
};

/** A partition's identity as one string, for maps and for messages. */
export const idOf = (key: PartitionKey): string =>
  [key.venue, key.market, descriptorOf(key), key.bundle === 'market' ? '@' : '*', key.grain, key.month].join('|');

/** `dataset` or `dataset,variant`, as names and directories write it. */
export const descriptorOf = (key: Pick<PartitionKey, 'dataset' | 'variant'>): string =>
  (key.variant ? `${key.dataset},${key.variant}` : key.dataset);

/** A month, `YYYYMM`, so many months on — or back, where negative. */
export const shiftMonth = (month: string, by: number): string => {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1 + by, 1));

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * `date[.partNN].ext`, and nothing after it — so a download in progress or a
 * file set aside beside a real one is not taken for a file of the partition.
 * The ending is one extension, or two where a compressed stream says what it is
 * (`.csv.gz`, `.tar.gz`); which ones a venue uses is nothing this has to know.
 */
const TAIL = /^(\d{6}|\d{8}|\d{10}|\d{12})(?:\.part\d+)?\.(?:[0-9a-z]*[a-z][0-9a-z]*\.(?=(?:gz|bz2|xz|zst)$))?(?!(?:bak|part\d*)$)[0-9a-z]*[a-z][0-9a-z]*$/;

/** The length of a file's date is its grain. */
const GRAINS: Record<number, Grain> = { 6: 'monthly', 8: 'daily', 10: 'hourly', 12: 'minutely' };
