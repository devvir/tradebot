import { holds, union, without } from './spans';
import type { DatabaseSync } from 'node:sqlite';
import type { Choice, LensDefinition, LensRule, LensSpan, PartitionMember, SliceTraits } from './types';

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

  return [...new Set([...venueNames(db), ...named])];
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
export const spansFor = (slice: SliceTraits, rules: readonly LensRule[]): LensSpan[] => {
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

/**
 * Of the partitions that are one month of one dataset in its several forms,
 * the ones a venue's rules let through.
 *
 * **Each include is taken on its own, then they are added up.** A rule matches
 * what it matches of the siblings; where it prefers a form and a sibling it
 * matches has it, the others it matched are left out — **the bundle first, then
 * the grain**, so a rule preferring both keeps the preferred bundle and, within
 * it, the preferred grain. What any include keeps is in; what any exclude
 * matches is out, whatever kept it.
 *
 * **A preference is settled among what is published, never against it.** A
 * month published only daily is kept by a rule that prefers monthly; the same
 * month published both ways is kept monthly alone.
 */
export const letThrough = (rules: readonly LensRule[], siblings: readonly PartitionMember[]): PartitionMember[] => {
  const kept = new Set<number>();

  for (const rule of rules) {
    if (rule.effect !== 'include') continue;

    let held = siblings.filter(one => covers(rule, one));

    held = preferring(held, rule.bundle, one => one.bundle);
    held = preferring(held, rule.grain, one => one.grain);

    for (const one of held) kept.add(one.partitionId);
  }

  for (const rule of rules)
    if (rule.effect === 'exclude')
      for (const one of siblings) if (covers(rule, one)) kept.delete(one.partitionId);

  return siblings.filter(one => kept.has(one.partitionId));
};

/** What makes partitions siblings: the same month of the same dataset of a market of a venue, in whatever form. */
export const siblingKey = (one: Pick<PartitionMember, 'venue' | 'market' | 'dataset' | 'variant' | 'month'>): string =>
  [one.venue, one.market, one.dataset, one.variant, one.month].join('\u0000');

// ── Internals ─────────────────────────────────────────────────────────────────

/** Whether a rule speaks about a partition: its slice, at its month. */
const covers = (rule: LensRule, one: PartitionMember): boolean =>
  matches(one, rule) && holds([{ from: rule.from ?? null, to: rule.to ?? null }], one.month);

/** The ones in the preferred form where any is, and all of them where none is or nothing is preferred. */
const preferring = <T>(
  held:   PartitionMember[],
  choice: Choice<T> | undefined,
  formOf: (one: PartitionMember) => unknown,
): PartitionMember[] => {
  if (typeof choice !== 'object' || choice === null || ! ('prefer' in choice)) return held;

  const preferred = held.filter(one => formOf(one) === choice.prefer);

  return preferred.length > 0 ? preferred : held;
};

/** Every venue the catalog has, by name. */
const venueNames = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT DISTINCT name FROM venue ORDER BY name').all() as { name: string }[]).map(one => one.name);

/**
 * Whether a rule speaks about this slice at all.
 *
 * **An absent dimension means all of it**, so a rule naming only a dataset
 * matches every market, variant, grain and bundle of it. A grain or a bundle
 * that is only preferred narrows nothing here — see `letThrough`.
 */
const matches = (slice: SliceTraits, rule: LensRule): boolean =>
  named(rule.markets, slice.market)
  && dataset(rule.datasets, slice)
  && only(rule.grain, slice.grain)
  && only(rule.bundle, slice.bundle);

/** Whether a choice leaves a form in: it does unless it is `only` another. */
const only = <T>(choice: Choice<T> | undefined, form: T): boolean =>
  typeof choice !== 'object' || choice === null || ! ('only' in choice) || choice.only === form;

/**
 * Whether any of the kinds a rule names is this slice's.
 *
 * **A pair with no variant is every variant of that dataset**, so `{ dataset:
 * 'trades' }` beside `{ dataset: 'klines', variant: '1m' }` is every trade and
 * one length of kline — which two flat lists could not say.
 */
const dataset = (kinds: LensRule['datasets'], slice: SliceTraits): boolean =>
  kinds === undefined
  || kinds.some(one => one.dataset === slice.dataset
    && (one.variant === undefined || one.variant === slice.variant));

const named = (values: readonly string[] | undefined, one: string): boolean =>
  values === undefined || values.includes(one);

