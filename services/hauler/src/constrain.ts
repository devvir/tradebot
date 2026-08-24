import { logger } from '@devvir/service-kit';
import { ANY } from './types';
import type { Config } from './types';
import type { Want } from './types';

/**
 * Take this deployment's slice of the shopping list.
 *
 * **The list is the standing intention and env is how one deployment bites off
 * part of it.** `HAULER_VENUES` already worked this way — absent means every
 * venue, present means only those — and `HAULER_MARKETS`, `HAULER_DATASETS`,
 * `HAULER_FROM` and `HAULER_TO` extend the same rule to the rest of a want's
 * fields, which is what lets the same list be split across concurrent
 * deployments without any of them writing to it.
 *
 * **Narrowing, never widening.** A want bounded to `202006..` stays bounded
 * there whatever `HAULER_FROM` says earlier than that — env can only take a
 * slice of what a want already covers, never restate it. That is the same
 * reason `venues` filters `wants()` rather than being unioned with what it
 * returns.
 */
export const constrain = (list: readonly Want[], config: Config): Want[] =>
  list
    .filter(one => covers(config.markets, one.market))
    .filter(one => covers(config.datasets, one.dataset))
    .map(one => narrow(one, config))
    .filter(kept);

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Whether this deployment's slice includes what a want names.
 *
 * **A wildcard survives every narrowing, because it does not name anything to
 * narrow.** `HAULER_DATASETS=klines` against a want for `*` means "the klines
 * of everything that want covers", which is a slice of it — where dropping the
 * want would leave the deployment fetching nothing at all and looking as though
 * the list were empty.
 *
 * The narrowing still happens: `*` is resolved against the catalog, and the env
 * filter applies to what comes back — see `planFor`.
 */
const covers = (slice: readonly string[], named: string): boolean =>
  slice.length === 0 || named === ANY || slice.includes(named);

/** A want's span, intersected with the deployment's — never widened past either. */
const narrow = (of: Want, config: Config): Want => {
  const from = later(of.from, config.from);
  const to   = earlier(of.to, config.to);

  return { ...of, ...optionally('from', from), ...optionally('to', to) };
};

/** The later of two months, either of which may be absent. */
const later = (a: string | undefined, b: string | undefined): string | undefined => {
  if (a === undefined) return b;

  if (b === undefined) return a;

  return a > b ? a : b;
};

/** The earlier of two months, either of which may be absent. */
const earlier = (a: string | undefined, b: string | undefined): string | undefined => {
  if (a === undefined) return b;

  if (b === undefined) return a;

  return a < b ? a : b;
};

/**
 * A want the intersection emptied out — `from` past `to` — is dropped rather
 * than sent on to ask the catalog for a range that names nothing.
 */
const kept = (of: Want): boolean => {
  const empty = of.from !== undefined && of.to !== undefined && of.from > of.to;

  if (empty)
    logger.warn({ venue: of.venue, market: of.market, dataset: of.dataset,
      from: of.from, to: of.to },
      'This deployment\'s HAULER_FROM/HAULER_TO leaves nothing of this want — skipping it');

  return ! empty;
};

const optionally = (name: 'from' | 'to', value: string | undefined): Record<string, string> =>
  value === undefined ? {} : { [name]: value };

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_later   = later;
export const _test_earlier = earlier;
