import { manager as facts } from './facts';
import type { FactKey, FactQuery } from '@tradebot/pipeline';
import type { Want } from './types';

/**
 * The shopping list: which datasets this deployment intends to fetch, and what
 it should get of each.
 *
 * **Fetching everything is not on the table.** The raw archives plus the vault
 * were estimated at 70 TB before two of the largest venues were indexed, so what
 * gets fetched is a choice — and this is where the choice is written down.
 *
 * **It lives in the facts database rather than in a deployed constant.** It
 * changes rarely enough that a constant would have served, but the facts
 * database is already the pipeline's open, queryable store, so putting the list
 * there means a tool or a dashboard can show *what we intend to fetch* beside
 * *what we have fetched* — one store, one query, no second format to learn.
 *
 * **A want states a requirement, never an answer.** *The smallest bar length,
 * monthly if there is a choice* keeps meaning the right thing when a venue drops
 * an interval; `1m monthly` written out silently fetches nothing the day it
 * does. Which shapes a want actually selects is worked out per pass against the
 * catalog — see `plan.ts`.
 *
 * ```
 * topic    archives:scope    the tree the fact is about
 * fact     wanted            what is asserted
 * venue    gate
 * market   perp              canonical
 * dataset  klines            canonical, and bare
 * subject  —                 unused: every row here is about the same thing
 * period   202101..202312    the months wanted, one end or both, or blank for all
 * meta     { fixed, prefer } the requirements, in hauler's own language
 * ```
 *
 * **The columns are used as columns and the rest is hauler's.** `venue`,
 * `market` and `dataset` are the pipeline's shared vocabulary and anything may
 * filter on them; `period` holds periods, as it does everywhere else. What has
 * no column is the requirement itself — `{ prefer: { interval: 'min' } }` means
 * nothing to any other service — so it goes in `meta`, which is exactly what
 * `meta` is for.
 *
 * The identity is `venue + market + dataset`, so there is **one row per dataset
 * of a venue**: two wants for one dataset would be two answers to one question.
 * Restating one replaces it, whatever its bounds were, because `want` clears the
 * same identity at any period first.
 */

/** Every want, or those of the named venues. */
export const wants = (venues: readonly string[] = []): Want[] =>
  facts().find({ topic: TOPIC, fact: FACT }, { meta: true })
    .filter(one => venues.length === 0 || venues.includes(one.venue))
    .map(read)
    .sort(byName);

/**
 * Add one, or restate the one already listed.
 *
 * **Whatever was there is cleared first**, because the bounds are part of the
 * row rather than of its identity: deciding to go back further, or to prefer a
 * different interval, must replace the want rather than sit beside it. Two rows
 * saying different things about one dataset is not a union, it is a question
 * nobody can answer.
 */
export const want = (adding: Want): Want => {
  facts().forgetAll(identity(adding));
  facts().record({ ...keyOf(adding), ...meta(adding) });

  return adding;
};

/**
 * Drop one, whatever it was listed with. Answers how many went.
 *
 * **A dataset of a venue is one want**, so this needs no more than that to name
 * it — and cannot half-drop one by disagreeing about its bounds or preferences.
 */
export const unwant = (dropping: Want): number => facts().forgetAll(identity(dropping));

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * **A subtopic, because the scope is not the archive.** `archives` carries what
 * is on disk; `archives:scope` carries what we intend there to be. Reading them
 * together is one query over one topic tree, and neither has to filter the
 * other's rows out.
 */
const TOPIC = 'archives:scope' as const;
const FACT  = 'wanted';

/** What a row says beyond its identity: the bounds are the key's, the rest is ours. */
interface Meta {
  fixed?:  Record<string, string>;
  prefer?: Record<string, string>;
}

/**
 * A want, read back out of a row.
 *
 * `period` holds the months asked for — one end, both ends around `..`, or
 * nothing at all for however far back the venue goes.
 */
const read = (one: { venue: string; market: string; dataset: string; period: string;
  meta?: unknown }): Want => {
  const [from, to] = one.period.split('..');
  const held       = (one.meta ?? {}) as Meta;

  return {
    venue:   one.venue,
    market:  one.market as Want['market'],
    dataset: one.dataset as Want['dataset'],
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(held.fixed ? { fixed: held.fixed } : {}),
    ...(held.prefer ? { prefer: held.prefer } : {}),
  };
};

/** The requirements, which no other service could interpret — so, `meta`. */
const meta = (of: Want): { meta?: Meta } => {
  const held: Meta = {
    ...(of.fixed ? { fixed: of.fixed } : {}),
    ...(of.prefer ? { prefer: of.prefer } : {}),
  };

  return Object.keys(held).length > 0 ? { meta: held } : {};
};

/**
 * What a want *is*, without its bounds or its requirements.
 *
 * **One dataset of one venue**, because that is the unit somebody decides about.
 * Wanting the minute bars and wanting every interval are not two wants — they
 * are one want, stated differently, and the second replaces the first.
 */
const identity = (of: Want): FactQuery => ({
  topic:   TOPIC,
  venue:   of.venue,
  market:  of.market,
  dataset: of.dataset,
  fact:    FACT,
});

/** `202101`, `202101..202312`, or blank for as far as the venue goes. */
const spanOf = (of: Want): string =>
  (of.to ? `${of.from ?? ''}..${of.to}` : of.from ?? '');

const keyOf = (of: Want): FactKey => ({
  topic:   TOPIC,
  venue:   of.venue,
  market:  of.market,
  dataset: of.dataset,
  period:  spanOf(of),
  fact:    FACT,
});

const byName = (a: Want, b: Want): number =>
  `${a.venue}|${a.market}|${a.dataset}`.localeCompare(`${b.venue}|${b.market}|${b.dataset}`);

// ── Test access ───────────────────────────────────────────────────────────────

export const _test_keyOf    = keyOf;
export const _test_identity = identity;
export const _test_read     = read;
export const _test_spanOf   = spanOf;
