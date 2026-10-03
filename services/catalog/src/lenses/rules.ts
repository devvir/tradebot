import { union, without } from './spans';
import { venues } from '../queries';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition, LensRule, LensSpan, Series } from '../types';

/**
 * What a lens's rules say about one venue and one series — the evaluation every
 * other part of a lens is built on: resolving, sizing, checking, and the rows of
 * `lens_series` that every view reads through.
 */

/**
 * The venues a lens speaks about.
 *
 * **Every venue there is, where the lens has global rules**, because a rule under
 * `*` is about all of them — and a lens whose only rule is *everything up to
 * 2020* should not have to name seven venues to say so.
 */
export const venuesIn = (db: DatabaseSync, definition: LensDefinition): string[] => {
  const named = Object.keys(definition.venues ?? {}).filter(one => one !== GLOBAL);

  if ((definition.venues?.[GLOBAL] ?? []).length === 0) return named;

  return [...new Set([...venues(db).map(one => one.name), ...named])];
};

/**
 * What a venue is actually read through: the global rules together with its
 * own, one pool of includes and excludes — which is what lets a lens say
 * *everything up to 2020, except bitget's books* in two rules instead of seven.
 */
export const rulesFor = (definition: LensDefinition, venue: string): LensRule[] =>
  [...(definition.venues?.[GLOBAL] ?? []), ...(definition.venues?.[venue] ?? [])];

/** The key a lens keeps its all-venue rules under. */
export const GLOBAL = '*';

/**
 * What one series is let through for: everything the lens's includes match,
 * minus everything its excludes match.
 *
 * **Order-free.** The includes are one set and the excludes another, so where a
 * rule sits never changes what the lens lets through — an exclude always wins
 * over an include it overlaps, and a carve-back is written as a narrower
 * exclude. Two rows come out where an exclude cuts a hole in an include.
 */
export const spansFor = (series: Series, rules: readonly LensRule[]): LensSpan[] => {
  let included: LensSpan[] = [];
  let excluded: LensSpan[] = [];

  for (const rule of rules) {
    if (! matches(series, rule)) continue;

    const span = { from: rule.from ?? null, to: rule.to ?? null };

    if (rule.effect === 'include') included = union(included, span);
    else excluded = union(excluded, span);
  }

  for (const span of excluded) included = without(included, span);

  return included;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Whether a rule speaks about this series at all.
 *
 * **An absent dimension means all of it**, so a rule naming only a dataset
 * matches every market, variant, grain and instrument of it.
 */
const matches = (series: Series, rule: LensRule): boolean =>
  named(rule.markets, series.market)
  && dataset(rule.datasets, series)
  && named(rule.grains as readonly string[] | undefined, series.grain)
  && named(rule.instruments, series.symbol);

/**
 * Whether any of the kinds a rule names is this series'.
 *
 * **A pair with no variant is every variant of that dataset**, so `{ dataset:
 * 'trades' }` beside `{ dataset: 'klines', variant: '1m' }` is every trade and
 * one length of kline — which two flat lists could not say.
 */
const dataset = (kinds: LensRule['datasets'], series: Series): boolean =>
  kinds === undefined
  || kinds.some(one => one.dataset === series.dataset
    && (one.variant === undefined || one.variant === series.variant));

const named = (values: readonly string[] | undefined, one: string): boolean =>
  values === undefined || values.includes(one);

