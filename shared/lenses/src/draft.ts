import { GLOBAL, letThrough, rulesFor, siblingKey, spansFor, venuesIn } from './rules';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Choice, LensDefinition, LensOption, LensPartition, LensProblem, LensResolved, LensRule, LensSize, LensSlice, Slice,
} from './types';

/**
 * Lenses: named ways of looking at the catalog.
 *
 * **Where a lens is in force, what it lets through *is* the catalog.** A consumer
 * asks what exists and gets the lens's answer; the rows underneath are untouched
 * and complete. Nothing here filters collection, storage or bookkeeping.
 *
 * **What a definition would let through, and whether it can be stored** — asked
 * of the catalog as it is, and of a document that may never be saved. Nothing
 * here writes.
 */

/**
 * What a definition says of each venue's slices: the ones it lets through, and
 * the months of each.
 *
 * **Includes minus excludes**, in no order: what any include matches, less what
 * any exclude matches (see `spansFor`). A slice nothing included is absent
 * rather than empty, and so is a venue with none.
 *
 * **Before any preference is settled**: a rule that prefers a form matches every
 * form, and which of them it keeps is decided month by month among the
 * partitions that are there — see `resolve`.
 */
export const resolveSlices = (db: DatabaseSync, definition: LensDefinition): Map<string, LensSlice[]> => {
  const out = new Map<string, LensSlice[]>();

  for (const venue of venuesIn(db, definition)) {
    const rules = rulesFor(definition, venue);
    const held  = slicesOf(db, venue)
      .map(slice => ({ slice, spans: spansFor(slice, rules) }))
      .filter(one => one.spans.length > 0);

    if (held.length > 0) out.set(venue, held);
  }

  return out;
};

/**
 * What a definition lets through: for each venue, its partitions.
 *
 * Decided the way a stored lens's rows are: a month of a dataset in its several
 * forms is one set of siblings, and the rules say which of them are let
 * through — see `letThrough`.
 */
export const resolve = (db: DatabaseSync, definition: LensDefinition): Map<string, LensPartition[]> => {
  const out = new Map<string, LensPartition[]>();

  for (const venue of venuesIn(db, definition)) {
    const rules  = rulesFor(definition, venue);
    const groups = new Map<string, LensPartition[]>();

    for (const one of partitionsOf(db, venue)) {
      const key = siblingKey(one);

      groups.set(key, [...groups.get(key) ?? [], one]);
    }

    const held = [...groups.values()].flatMap(siblings => letThrough(rules, siblings) as LensPartition[]);

    if (held.length > 0) out.set(venue, held);
  }

  return out;
};

/** What a definition selects, per venue: how many slices, how many partitions, and the months as its rules bound them. */
export const resolvedSummary = (db: DatabaseSync, definition: LensDefinition): Record<string, LensResolved> => {
  const partitions = resolve(db, definition);

  return Object.fromEntries([...resolveSlices(db, definition)].map(([venue, slices]) => [venue, {
    slices:     slices.length,
    partitions: partitions.get(venue)?.length ?? 0,
    spans:      [...new Set(slices.flatMap(one => one.spans.map(span => `${span.from ?? ''}..${span.to ?? ''}`)))].sort(),
  }]));
};

/**
 * What the venues publish, as a rule is written against: every combination
 * that has a series, and the venue it is of.
 *
 * All of them at once, since an editor needs them together: a venue's own
 * rules are written against its rows, the rules for every venue against all of
 * them, and which venues hold a market or a dataset is read off the same list.
 */
export const lensOptions = (db: DatabaseSync): LensOption[] => {
  const had = OPTIONS.get(db);

  if (had && Date.now() - had.at < OPTIONS_MS) return had.options;

  const options = db.prepare(
    `SELECT DISTINCT c.venue, c.market, c.dataset, c.variant, c.grain
       FROM slice c
      WHERE EXISTS (SELECT 1 FROM pattern p JOIN series s ON s.pattern_id = p.id WHERE p.slice_id = c.id)
      ORDER BY c.venue, c.market, c.dataset, c.variant, c.grain`,
  ).all() as unknown as LensOption[];

  OPTIONS.set(db, { at: Date.now(), options });

  return options;
};

/**
 * Why a lens cannot be stored, in a person's words.
 *
 * **Only what is not a rule at all is refused**: a definition that is not one
 * document of venues each with a list of rules, a rule that is not shaped as
 * one, a venue that does not exist, a grain or a bundle that is not one, an
 * exclude that prefers, a bound that is not a month, a range that ends before it
 * starts. Whatever is sent, the answer is a list of problems and never an
 * exception.
 *
 * **What a rule matches is never weighed.** A rule that selects nothing today,
 * or a form taken alone that only part of what the rule names is published in,
 * may be exactly what was meant — and where it was not, preferring the form
 * says so. Every problem names the venue and the rule's position, so an editor
 * can put it where the choice was made; a problem with the definition as a
 * whole names venue `''` and rule `-1`, and one with a venue's list rule `-1`.
 */
export const problemsWith = (db: DatabaseSync, definition: unknown): LensProblem[] => {
  if (! plain(definition))
    return [{ venue: '', rule: -1, message: 'A definition is a document of venues, each with its rules.' }];

  const venues = definition['venues'];

  if (venues === undefined) return [];

  if (! plain(venues))
    return [{ venue: '', rule: -1, message: 'The venues of a definition are named, each with its rules.' }];

  const out: LensProblem[] = [];

  const known = new Set(venueNames(db));

  for (const [venue, rules] of Object.entries(venues)) {
    if (venue !== GLOBAL && ! known.has(venue)) {
      out.push({ venue, rule: -1, message: `No venue called '${venue}'.` });

      continue;
    }

    if (! Array.isArray(rules)) {
      out.push({ venue, rule: -1, message: 'A venue\'s rules are a list.' });

      continue;
    }

    rules.forEach((rule: unknown, at) => {
      const shape = misshapen(rule);

      out.push(...(shape.length > 0 ? shape : faultsOf(rule as LensRule)).map(one => ({ venue, rule: at, ...one })));
    });
  }

  return out;
};

/**
 * What is wrong with the shape of one rule: that it is not a rule at all, and
 * so cannot be weighed. Nothing where every part of it is of its kind, whatever
 * the values say.
 *
 * **Never throws**, whatever it is handed. A rule this passes is one every
 * evaluation can read.
 */
export const misshapen = (rule: unknown): Fault[] => {
  if (! plain(rule)) return [{ message: 'A rule is an effect and what it matches.' }];

  const out: Fault[] = [];

  for (const key of Object.keys(rule))
    if (! (RULE_KEYS as readonly string[]).includes(key))
      out.push({ message: `A rule has no '${key}': it is ${RULE_KEYS.join(', ')}.` });

  if (rule['effect'] !== 'include' && rule['effect'] !== 'exclude')
    out.push({ field: 'effect', message: 'A rule either includes or excludes.' });

  if (rule['markets'] !== undefined && ! strings(rule['markets']))
    out.push({ field: 'markets', message: 'Markets are a list of market names; leave it out for every market.' });

  if (rule['datasets'] !== undefined
      && ! (Array.isArray(rule['datasets']) && rule['datasets'].every(kind)))
    out.push({ field: 'datasets', message: 'Datasets are a list, each a dataset and optionally one of its variants; leave it out for every dataset.' });

  if (rule['grain'] !== undefined && ! choice(rule['grain']))
    out.push({ field: 'grain', message: GRAIN_IS });

  if (rule['bundle'] !== undefined && ! choice(rule['bundle']))
    out.push({ field: 'bundle', message: BUNDLE_IS });

  for (const field of ['from', 'to'] as const)
    if (rule[field] !== undefined && typeof rule[field] !== 'string')
      out.push({ field, message: `'${String(rule[field])}' is not a month. ${BOUND_IS}` });

  return out;
};

/** What is wrong with one rule of a proper shape. */
const faultsOf = (rule: LensRule): Fault[] => {
  const out: Fault[] = [];

  if (rule.grain !== undefined && ! GRAINS.includes(formOf(rule.grain) as never))
    out.push({ field: 'grain', message: GRAIN_IS });

  if (rule.bundle !== undefined && ! BUNDLES.includes(formOf(rule.bundle) as never))
    out.push({ field: 'bundle', message: BUNDLE_IS });

  /**
   * **An exclude has nothing to prefer.** Preferring is choosing what to keep
   * among the forms a month is published in, and an exclude keeps nothing.
   */
  if (rule.effect === 'exclude' && [rule.grain, rule.bundle].some(one => prefers(one)))
    out.push({ field: prefers(rule.grain) ? 'grain' : 'bundle',
      message: 'An exclude cannot prefer a form: it takes away what it matches. Make it only that form, or any.' });

  /**
   * **A bound is a month.** A day would be a false precision — nobody
   * collects up to the 14th — and a file covering a whole month cannot be
   * halved by one, so the two ends would stop meaning the same thing.
   */
  for (const [field, bound] of [['from', rule.from], ['to', rule.to]] as const)
    if (bound !== undefined && ! /^\d{4}(0[1-9]|1[0-2])$/.test(bound))
      out.push({ field, message: `'${bound}' is not a month. ${BOUND_IS}` });

  if (rule.from && rule.to && rule.from > rule.to)
    out.push({ field: 'to', message: 'The end is before the start.' });

  return out;
};

/**
 * How much a definition would put on a disk, before it is saved — the editor
 * asks on every change. A saved lens is sized off its rows instead; see
 * `savedLensSize`.
 *
 * Exact, always: summed over the partitions the definition lets through, each of
 * which carries its own counts. No file is read.
 */
export const lensSize = (db: DatabaseSync, definition: LensDefinition): LensSize => {
  const total: LensSize = { partitions: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 };

  for (const held of resolve(db, definition).values())
    for (const one of held) {
      total.partitions++;
      total.files        += one.files;
      total.bytes        += one.bytes;
      total.pending      += one.pending;
      total.pendingBytes += one.pendingBytes;
    }

  return total;
};

/** Whether a slug is one a consumer can pass anywhere without quoting it. */
export const lensNameIsSound = (slug: string): boolean => /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug);

// ── Internals ─────────────────────────────────────────────────────────────────

const GRAINS  = ['monthly', 'daily', 'hourly', 'minutely'] as const;
const BUNDLES = ['instrument', 'market'] as const;

/** Every part a rule can have. */
const RULE_KEYS = ['effect', 'markets', 'datasets', 'grain', 'bundle', 'from', 'to'] as const;

const GRAIN_IS  = `A grain is only one of ${GRAINS.join(', ')}, or prefers one; leave it out for any.`;
const BUNDLE_IS = 'A bundle is only instrument or market, or prefers one; leave it out for either.';
const BOUND_IS  = 'Bounds are written yyyymm.';

/** A problem with one rule, before it is placed at its venue and position. */
type Fault = Omit<LensProblem, 'venue' | 'rule'>;

/** Whether something is a document of named parts: an object, and not a list. */
const plain = (one: unknown): one is Record<string, unknown> =>
  typeof one === 'object' && one !== null && ! Array.isArray(one);

const strings = (one: unknown): one is string[] =>
  Array.isArray(one) && one.every(each => typeof each === 'string');

/** Whether one entry of `datasets` is a dataset, with a variant or without. */
const kind = (one: unknown): boolean =>
  plain(one)
  && typeof one['dataset'] === 'string'
  && (one['variant'] === undefined || typeof one['variant'] === 'string')
  && Object.keys(one).every(key => key === 'dataset' || key === 'variant');

/** Whether a grain or a bundle is written as a `Choice`: one of `only` and `prefer`, and nothing else. */
const choice = (one: unknown): boolean =>
  plain(one) && Object.keys(one).length === 1 && ('only' in one || 'prefer' in one);

/**
 * What each venue offers, as last counted. Counting is a read of every series a
 * venue has, and an editor asks it every time a rule's venue is opened — for
 * something that changes when a venue starts publishing a
 * dataset, which is not often. So an answer is kept for `OPTIONS_MS`.
 */
const OPTIONS = new WeakMap<DatabaseSync, { at: number; options: LensOption[] }>();

const OPTIONS_MS = 5 * 60_000;

/** The form a choice names, whichever way it names it. */
const formOf = <T>(choice: Choice<T> | undefined): T | undefined =>
  (choice === null || typeof choice !== 'object' ? undefined : 'only' in choice ? choice.only : (choice as { prefer: T }).prefer);

/** Whether a choice prefers a form — of whatever a caller sent in its place. */
const prefers = (choice: unknown): boolean => typeof choice === 'object' && choice !== null && 'prefer' in choice;

/** Every venue the catalog has, by name. */
const venueNames = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT DISTINCT name FROM venue ORDER BY name').all() as { name: string }[]).map(one => one.name);

/** A venue's slices, whether or not any holds a file. */
const slicesOf = (db: DatabaseSync, venue: string): Slice[] =>
  db.prepare('SELECT id, venue, market, dataset, variant, grain, bundle FROM slice WHERE venue = ? ORDER BY id')
    .all(venue) as unknown as Slice[];

/** A venue's partitions with their slices' traits and what each holds. */
const partitionsOf = (db: DatabaseSync, venue: string): LensPartition[] =>
  db.prepare(
    `SELECT q.id AS partitionId, q.month, q.files, q.bytes, q.pending, q.pending_bytes AS pendingBytes,
            c.id, c.venue, c.market, c.dataset, c.variant, c.grain, c.bundle
       FROM slice c JOIN partition q ON q.slice_id = c.id
      WHERE c.venue = ?
      ORDER BY c.id, q.month`,
  ).all(venue) as unknown as LensPartition[];
