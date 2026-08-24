import { logger } from '@devvir/service-kit';
import { shapes } from './catalog';
import type { Plan, Shape, Want } from './types';

/**
 * Turning *what we want* into *what to fetch*, against what a venue actually
 * publishes.
 *
 * **This is the layer that keeps a shopping list honest.** A want says "the
 * smallest bar length, monthly if there is a choice, the venue-wide file if
 * there is one" — a sentence about requirements, which stays true when a venue
 * drops an interval, starts publishing daily, or lists a thousand new symbols.
 * Writing the resolved answer into the list instead is how a want quietly
 * fetches nothing the day a venue moves.
 *
 * So the answer is worked out per pass, from the catalog's own account of what it
 * holds. Nothing here knows a venue: it reads shapes and applies the rules the
 * want states.
 */

/**
 * What one want resolves to at its venue, which may be several listings or none.
 *
 * The order is: ask what exists, discard what a fixed requirement forbids, then
 * let each preference narrow what is left — and whatever survives is fetched.
 */
export const planFor = async (want: Want): Promise<Plan[]> => {
  const offered = await shapes(want.venue, want.market, want.dataset);

  if (offered.length === 0) {
    logger.warn({ ...naming(want) },
      'The catalog has no shapes for this — check the names against GET /venues/:venue/shapes');

    return [];
  }

  /**
   * **A fixed requirement is "this or nothing".** Nothing falls back, because a
   * caller who named a book depth did not mean "or a different one" — see
   * `Want.fixed`.
   */
  const allowed = required(offered, want.fixed ?? {});

  if (allowed.length === 0) {
    logger.warn({ ...naming(want), fixed: want.fixed, offered: offered.map(label) },
      'Nothing this venue publishes matches what was required — fetching none of it');

    return [];
  }

  const chosen = preferred(allowed, want.prefer ?? {});

  logger.info({ ...naming(want), plans: chosen.map(label) }, 'Resolved a want');

  return chosen.map(shape => ({
    venue:   want.venue,
    market:  shape.market,
    dataset: shape.dataset,
    variant: variantOf(shape),
    grain:   shape.grain,
    buckets: want.fixed?.['scope'] === 'bucket'
      || (want.prefer?.['scope'] === 'bucket' && shape.buckets > 0),
    ...(want.from ? { from: want.from } : {}),
    ...(want.to ? { to: want.to } : {}),
  }));
};

/**
 * The canonical variant string, rebuilt from the levels the catalog named.
 *
 * **Joined in the order they arrive**, which is the order the levels belong in —
 * the same rule the archive path follows, and for the same reason.
 */
export const variantOf = (shape: Shape): string => Object.values(shape.variant).join(',');

// ── Internals ─────────────────────────────────────────────────────────────────

/** Every shape that satisfies every fixed requirement. */
const required = (offered: readonly Shape[], fixed: Record<string, string>): Shape[] =>
  Object.entries(fixed).reduce<Shape[]>(
    (left, [key, value]) => left.filter(shape => matches(shape, key, value)), [...offered]);

/**
 * The shapes left once each preference has had its turn.
 *
 * **A preference that would leave nothing is skipped.** That is the whole
 * difference between preferring and requiring, and it is what lets one sentence
 * survive a venue rearranging itself: no monthly rendering means daily, no `1m`
 * means whatever the finest is.
 *
 * They are applied in key order, so the first one written wins where two cannot
 * both be had.
 */
const preferred = (allowed: readonly Shape[], prefer: Record<string, string>): Shape[] =>
  Object.entries(prefer).reduce<Shape[]>((left, [key, value]) => {
    const kept = value === 'min' || value === 'max'
      ? extreme(left, key, value)
      : left.filter(shape => matches(shape, key, value));

    return kept.length > 0 ? kept : left;
  }, [...allowed]);

/**
 * Whether a shape is the thing a key names.
 *
 * Three kinds of key and no table of datasets: `grain` and `scope` are properties
 * of the shape itself, and everything else is a level of the variant — whose
 * names come from the catalog, so a dataset growing a new level needs no change
 * here.
 */
const matches = (shape: Shape, key: string, value: string): boolean => {
  if (key === 'grain') return shape.grain === value;

  if (key === 'scope') return value === 'bucket' ? shape.buckets > 0 : shape.symbols > 0;

  return shape.variant[key] === value;
};

/**
 * The shapes holding the smallest or largest value of one level.
 *
 * **Ties are kept, not broken.** Two shapes at `1m` differing only in grain are
 * both still candidates, and the next preference decides between them — which is
 * how `{ interval: 'min', grain: 'monthly' }` reads: the finest bars, monthly if
 * those come both ways.
 *
 * A level nothing can be sized by — a mode, an aggregation — has no smallest, so
 * this leaves the field alone rather than picking alphabetically.
 */
const extreme = (shapes: readonly Shape[], key: string, want: 'min' | 'max'): Shape[] => {
  const sized = shapes
    .map(shape => ({ shape, size: sizeOf(shape.variant[key]) }))
    .filter((one): one is { shape: Shape; size: number } => one.size !== undefined);

  if (sized.length === 0) return [];

  const target = want === 'min'
    ? Math.min(...sized.map(one => one.size))
    : Math.max(...sized.map(one => one.size));

  return sized.filter(one => one.size === target).map(one => one.shape);
};

/** How long each unit lasts. A month is nominal: it only has to sort above a week. */
const SECONDS: Record<string, number> = {
  s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800, mo: 2_592_000,
};

/**
 * What a level's value is worth, for the one purpose of ordering it.
 *
 * A duration where it is one — `mo` matched before `m`, or every month would be
 * three minutes — and a plain number where it is a depth. Anything else has no
 * size, which is not a failure: a mode is not larger or smaller than another
 * mode.
 *
 * **`ticks` is the finest thing there is.** An unbinned series carries every
 * event rather than a summary of a span, so under "the smallest interval" it is
 * the answer, and it sorts below any bar.
 */
export const sizeOf = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;

  if (value === 'ticks') return 0;

  const duration = /^(\d+)(mo|[smhdw])$/.exec(value);

  if (duration) return Number(duration[1]) * SECONDS[duration[2]!]!;

  return /^\d+$/.test(value) ? Number(value) : undefined;
};

/** A shape, short enough for a log line. */
const label = (shape: Shape): string =>
  [shape.dataset, ...Object.values(shape.variant), shape.grain,
    shape.buckets > 0 ? `@x${shape.buckets}` : `${shape.symbols} symbols`].join('/');

const naming = (want: Want) => ({ venue: want.venue, market: want.market, dataset: want.dataset });

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_required  = required;
export const _test_preferred = preferred;
