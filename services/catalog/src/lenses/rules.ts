import { holds, union, without } from './spans';
import { venues } from '../queries';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition, LensRule, LensSpan, Slice } from '../types';

/**
 * What a lens's rules say about one venue and one slice — the evaluation every
 * other part of a lens is built on: resolving, sizing, and the rows of
 * `lens_member` that every view reads through.
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
 * The months one slice is let through for: everything the lens's includes
 * match, minus everything its excludes match.
 *
 * **Order-free.** The includes are one set and the excludes another, so where a
 * rule sits never changes what the lens lets through — an exclude always wins
 * over an include it overlaps, and a carve-back is written as a narrower
 * exclude. Two rows come out where an exclude cuts a hole in an include.
 */
export const spansFor = (slice: Traits, rules: readonly LensRule[]): LensSpan[] => {
  let included: LensSpan[] = [];
  let excluded: LensSpan[] = [];

  for (const rule of rules) {
    if (! matches(slice, rule)) continue;

    const span = { from: rule.from ?? null, to: rule.to ?? null };

    if (rule.effect === 'include') included = union(included, span);
    else excluded = union(excluded, span);
  }

  for (const span of excluded) included = without(included, span);

  return included;
};

/**
 * Whether a lens lets a partition through: its slice, at its month.
 *
 * **A rule never reaches inside a partition** — it names traits of a slice and
 * a span of months — so a partition is let through whole or not at all.
 */
export const lets = (spans: readonly LensSpan[], month: string): boolean => holds(spans, month);

// ── Internals ─────────────────────────────────────────────────────────────────

/** What a rule is matched against: a slice's traits, wherever they were read from. */
type Traits = Pick<Slice, 'market' | 'dataset' | 'variant' | 'grain' | 'bundle'>;

/**
 * Whether a rule speaks about this slice at all.
 *
 * **An absent dimension means all of it**, so a rule naming only a dataset
 * matches every market, variant, grain and bundle of it.
 */
const matches = (slice: Traits, rule: LensRule): boolean =>
  named(rule.markets, slice.market)
  && dataset(rule.datasets, slice)
  && named(rule.grains as readonly string[] | undefined, slice.grain)
  && (rule.bundle === undefined || rule.bundle === slice.bundle);

/**
 * Whether any of the kinds a rule names is this slice's.
 *
 * **A pair with no variant is every variant of that dataset**, so `{ dataset:
 * 'trades' }` beside `{ dataset: 'klines', variant: '1m' }` is every trade and
 * one length of kline — which two flat lists could not say.
 */
const dataset = (kinds: LensRule['datasets'], slice: Traits): boolean =>
  kinds === undefined
  || kinds.some(one => one.dataset === slice.dataset
    && (one.variant === undefined || one.variant === slice.variant));

const named = (values: readonly string[] | undefined, one: string): boolean =>
  values === undefined || values.includes(one);

