/**
 * How the catalog presents what it holds.
 *
 * **A convention, not a contract with the collector.** Prospector writes
 * canonical names into the database; how a consumer is shown them — a variant
 * split into the levels it is made of, the venue-wide file named `@` — is this
 * service's own choice.
 */

/** The venue-wide file: one file carrying every instrument of a market. */
export const BUCKET = '@';

/** How often a shape can publish. */
export const GRAINS = ['monthly', 'daily', 'hourly', 'minutely'] as const;

/**
 * One dataset's variant, taken apart into the levels it is made of.
 *
 * `books` + `incremental,400` becomes `{ kind: 'incremental', depth: '400' }`,
 * and a dataset with no levels — or a series with no variant — becomes `{}`.
 * **Order is preserved**, so anything rebuilding the string can join the values
 * as they come.
 */
export const levelsOf = (dataset: string, variant: string): Record<string, string> => {
  const names = LEVELS[dataset] ?? [];

  /**
   * **A level with a default is always reported**, even where nothing is stored
   * against it, so a consumer never has to treat "no variant" and "the ordinary
   * one" as two cases.
   */
  if (variant === '')
    return Object.fromEntries(names.filter(name => name in DEFAULTS).map(name => [name, DEFAULTS[name]!]));

  const parts = variant.split(',');
  const found: Record<string, string> = {};

  names.forEach((name, at) => {
    // The last name takes whatever is left, so a level nobody has named yet is reported.
    const value = at === names.length - 1 ? parts.slice(at).join(',') : parts[at];

    if (value) found[name] = value;
  });

  return found;
};

/** The month after a `yyyymm`, in the same form. */
export const nextMonth = (month: string): string => {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 1));

  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** What the levels of each dataset's variant are, in the order they are written. */
const LEVELS: Record<string, readonly string[]> = {
  klines:          ['interval'],
  markPrice:       ['interval'],
  indexPrice:      ['interval'],
  premiumIndex:    ['interval'],
  volatilityIndex: ['interval'],
  optionSummary:   ['interval'],
  optionTicker:    ['interval'],
  books:           ['kind', 'depth'],
  trades:          ['aggregation'],
  funding:         ['kind'],
};

/**
 * What a level means where nothing is stored against it — only where the
 * absence is itself meaningful: trades with no aggregation recorded are simply
 * the trades that venue publishes.
 */
const DEFAULTS: Record<string, string> = { aggregation: 'default' };
