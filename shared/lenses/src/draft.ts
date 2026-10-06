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
 * What a venue publishes, as a rule is written against.
 *
 * Every combination that has a series, with how many — which is what lets an
 * editor offer only the datasets a venue actually has, and say how much sits
 * behind each choice.
 */
export const lensOptions = (db: DatabaseSync, venue: string): LensOption[] => {
  const held = OPTIONS.get(db) ?? new Map<string, { at: number; options: LensOption[] }>();
  const had  = held.get(venue);

  OPTIONS.set(db, held);

  if (had && Date.now() - had.at < OPTIONS_MS) return had.options;

  /**
   * **`*` is offered what every venue publishes between them.** A rule under it
   * is about all of them, so a dataset one venue has is a dataset the rule may
   * name — it simply matches nothing at the venues without it.
   */
  const options = db.prepare(
    `SELECT c.market, c.dataset, c.variant, c.grain,
            COUNT(s.id)                                         AS series,
            SUM(CASE WHEN c.bundle = 'market' THEN 1 ELSE 0 END) AS buckets
       FROM slice c
       JOIN pattern p ON p.slice_id = c.id
       JOIN series s  ON s.pattern_id = p.id
      WHERE ? = '${GLOBAL}' OR c.venue = ?
      GROUP BY c.market, c.dataset, c.variant, c.grain
      ORDER BY c.market, c.dataset, c.variant, c.grain`,
  ).all(venue, venue) as unknown as LensOption[];

  held.set(venue, { at: Date.now(), options });

  return options;
};

/**
 * Why a lens cannot be stored, in a person's words.
 *
 * **Only what is not a rule at all is refused**: a venue that does not exist, a
 * grain or a bundle that is not one, an exclude that prefers, a bound that is
 * not a month, a range that ends before it starts.
 *
 * **What a rule matches is never weighed.** A rule that selects nothing today,
 * or a form taken alone that only part of what the rule names is published in,
 * may be exactly what was meant — and where it was not, preferring the form
 * says so. Every problem names the venue and the rule's position, so an editor
 * can put it where the choice was made.
 */
export const problemsWith = (db: DatabaseSync, definition: LensDefinition): LensProblem[] => {
  const out: LensProblem[] = [];

  const known = new Set(venueNames(db));

  for (const [venue, rules] of Object.entries(definition.venues ?? {})) {
    if (venue !== GLOBAL && ! known.has(venue)) {
      out.push({ venue, rule: -1, message: `No venue called '${venue}'.` });

      continue;
    }

    out.push(...faultsIn(rules, venue));
  }

  return out;
};

/** What is wrong with one venue's rules. */
const faultsIn = (rules: readonly LensRule[], venue: string): LensProblem[] => {
  const out: LensProblem[] = [];

  rules.forEach((rule, at) => {
    if (rule.grain !== undefined && ! GRAINS.includes(formOf(rule.grain) as never))
      out.push({ venue, rule: at, field: 'grain',
        message: `A grain is only one of ${GRAINS.join(', ')}, or prefers one; leave it out for any.` });

    if (rule.bundle !== undefined && ! BUNDLES.includes(formOf(rule.bundle) as never))
      out.push({ venue, rule: at, field: 'bundle',
        message: 'A bundle is only instrument or market, or prefers one; leave it out for either.' });

    /**
     * **An exclude has nothing to prefer.** Preferring is choosing what to keep
     * among the forms a month is published in, and an exclude keeps nothing.
     */
    if (rule.effect === 'exclude' && [rule.grain, rule.bundle].some(one => prefers(one)))
      out.push({ venue, rule: at, field: prefers(rule.grain) ? 'grain' : 'bundle',
        message: 'An exclude cannot prefer a form: it takes away what it matches. Make it only that form, or any.' });

    /**
     * **A bound is a month.** A day would be a false precision — nobody
     * collects up to the 14th — and a file covering a whole month cannot be
     * halved by one, so the two ends would stop meaning the same thing.
     */
    for (const [field, bound] of [['from', rule.from], ['to', rule.to]] as const)
      if (bound !== undefined && ! /^\d{4}(0[1-9]|1[0-2])$/.test(bound))
        out.push({ venue, rule: at, field,
          message: `'${bound}' is not a month. Bounds are written yyyymm.` });

    if (rule.from && rule.to && rule.from > rule.to)
      out.push({ venue, rule: at, field: 'to',
        message: 'The end is before the start.' });
  });

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

/**
 * What each venue offers, as last counted. Counting is a read of every series a
 * venue has, and an editor asks it every time a rule's venue is opened — for
 * something that changes when a venue starts publishing a
 * dataset, which is not often. So an answer is kept for `OPTIONS_MS`.
 */
const OPTIONS = new WeakMap<DatabaseSync, Map<string, { at: number; options: LensOption[] }>>();

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
