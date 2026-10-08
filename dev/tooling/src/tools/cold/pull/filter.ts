import type { Chosen } from '../types';
import type { Preference, PullFilter } from './types';

/**
 * What a pull is narrowed to, read off the command line.
 *
 * One of two is required, since a venue alone is everything it ever published:
 *
 * - `--dataset`: `dataset` or `dataset,variant`, in any market.
 * - `--partition`: `market/dataset[,variant]/YYYYMM`, or as much of it as is
 *   meant from the left — a market, a market's dataset, one variant of it, a
 *   year of that.
 *
 * `--date` narrows either to a year or a month, and is not given where the
 * partition already names one. Throws, with what was wrong, on anything else.
 */
export const filterOf = (given: { dataset?: string; partition?: string; date?: string }): PullFilter => {
  if (! given.dataset && ! given.partition) throw new Error('A pull needs --dataset or --partition: a venue alone is everything it ever published');
  if (given.dataset && given.partition)     throw new Error('--dataset and --partition say the same thing two ways — give one');

  const filter: PullFilter = given.partition ? ofPartition(given.partition) : ofDescriptor(given.dataset!);

  if (given.date) {
    if (filter.from) throw new Error('The partition already names its months — --date is one too many');

    Object.assign(filter, monthsOf(given.date, '--date'));
  }

  return filter;
};

/**
 * Which rendering is preferred, read off the command line: a grain, a bundle,
 * both or neither — and never two of the same kind. Throws on that.
 */
export const preferenceOf = (given: Pick<Chosen, 'preferMonthly' | 'preferDaily' | 'preferBundled' | 'preferNotBundled'>): Preference => {
  if (given.preferMonthly && given.preferDaily)      throw new Error('--prefer-monthly and --prefer-daily are one or the other');
  if (given.preferBundled && given.preferNotBundled) throw new Error('--prefer-bundled and --prefer-not-bundled are one or the other');

  return {
    ...(given.preferMonthly ? { grain: 'monthly' as const } : given.preferDaily ? { grain: 'daily' as const } : {}),
    ...(given.preferBundled ? { bundle: 'market' as const } : given.preferNotBundled ? { bundle: 'instrument' as const } : {}),
  };
};

/**
 * Of several renderings of the same data — one market, dataset, variant and
 * month — the ones preferred: those of the grain asked for where there are any,
 * then those of the bundle asked for where there are any. Everything, where
 * nothing is preferred.
 */
export const preferred = <T extends { market: string; dataset: string; variant: string; month: string; grain: string; bundle: string }>(
  found:  readonly T[],
  prefer: Preference = {},
): T[] => {
  const groups = new Map<string, T[]>();

  for (const one of found) {
    const data = [one.market, one.dataset, one.variant, one.month].join('|');

    groups.set(data, [...groups.get(data) ?? [], one]);
  }

  const narrowed = (group: T[], by: 'grain' | 'bundle'): T[] => {
    const liked = prefer[by] ? group.filter(one => one[by] === prefer[by]) : [];

    return liked.length > 0 ? liked : group;
  };

  return [...groups.values()].flatMap(group => narrowed(narrowed(group, 'grain'), 'bundle'));
};

/** Whether a partition is one the filter means. */
export const means = (
  filter: PullFilter,
  one:    { market: string; dataset: string; variant: string; month: string },
): boolean =>
  (! filter.market || filter.market === one.market)
  && (! filter.dataset || filter.dataset === one.dataset)
  && (filter.variant === undefined || filter.variant === one.variant)
  && (! filter.from || one.month >= filter.from)
  && (! filter.to || one.month <= filter.to);

// ── Internals ─────────────────────────────────────────────────────────────────

const ofPartition = (text: string): PullFilter => {
  const [market, descriptor, months, ...rest] = text.split('/');

  if (! market || rest.length > 0 || descriptor === '' || months === '')
    throw new Error(`"${text}" is not a partition: market[/dataset[,variant][/YYYY[MM]]]`);

  return {
    market,
    ...(descriptor ? ofDescriptor(descriptor) : {}),
    ...(months ? monthsOf(months, 'A partition\'s month') : {}),
  };
};

/** `dataset`, or `dataset,variant` — the variant being everything after the first comma. */
const ofDescriptor = (text: string): PullFilter => {
  const comma = text.indexOf(',');

  return comma < 0 ? { dataset: text } : { dataset: text.slice(0, comma), variant: text.slice(comma + 1) };
};

/** A year or a month as the months it covers. */
const monthsOf = (text: string, what: string): Pick<PullFilter, 'from' | 'to'> => {
  const found = /^(\d{4})-?(\d{2})?$/.exec(text);

  if (! found) throw new Error(`${what} is YYYY or YYYYMM, not "${text}"`);

  const [, year, month] = found;

  return month ? { from: `${year}${month}`, to: `${year}${month}` } : { from: `${year}01`, to: `${year}12` };
};
