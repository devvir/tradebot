import { dropMembers, rebuildMembers } from './members';
import { GLOBAL, lets, rulesFor, spansFor, venuesIn } from './rules';
import { partitionsOf, slicesOf } from '../partitions';
import { seriesFor, venueIds, venues } from '../queries';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Lens, LensDefinition, LensOption, LensProblem, LensResolved, LensRow, LensRule, LensSize, LensSlice, Partition,
} from '../types';

/**
 * Lenses: named ways of looking at the catalog.
 *
 * **Where a lens is in force, what it lets through *is* the catalog.** A consumer
 * asks what exists and gets the lens's answer; the rows underneath are untouched
 * and complete. Nothing here filters collection, storage or bookkeeping.
 *
 * One row per lens, definition as a JSON document, read whole and written whole.
 * Nothing queries across rules, so normalising them would buy filtering,
 * searching and indexing that nobody wants.
 */

/** Every lens, newest first. */
export const lenses = (db: DatabaseSync): Lens[] =>
  (db.prepare('SELECT * FROM lens ORDER BY updated_at DESC').all() as unknown as LensRow[])
    .map(asLens);

/**
 * One lens by the slug a consumer is configured with, or null where there is
 * none.
 *
 * **Never by its `name`.** That is what a person calls it and is free to change;
 * addressing by it would mean renaming a lens reconfigures whoever reads through
 * it.
 */
export const lensNamed = (db: DatabaseSync, slug: string): Lens | null => {
  const row = db.prepare('SELECT * FROM lens WHERE slug = ?').get(slug) as LensRow | undefined;

  return row ? asLens(row) : null;
};

/**
 * Make one, or fail because the name is taken.
 *
 * The name is the handle a consumer passes, so it is the thing that must be
 * unique — and the caller gets `null` rather than an exception, because a name
 * already in use is an ordinary answer to give a form.
 */
export const putLens = (
  db:         DatabaseSync,
  slug:       string,
  name:       string,
  note:       string,
  definition: LensDefinition = EMPTY,
): Lens | null => {
  const at = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO lens (slug, name, note, definition, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(slug, name || slug, note, JSON.stringify(definition), at, at);
  } catch {
    return null;
  }

  const made = lensNamed(db, slug);

  if (made) rebuildMembers(db, made);

  return made;
};

/**
 * Replace a lens, whole.
 *
 * **There is no `PATCH` of one rule**, which is why rules need no stable ids and
 * their position in the array is identity enough. Editing one lens from two
 * places at once is a thing not to do rather than a thing to guard against, and
 * last write wins is the obvious outcome.
 */
export const editLens = (
  db:    DatabaseSync,
  slug:  string,
  to:    { slug?: string; name?: string; note?: string; definition?: LensDefinition },
): Lens | null => {
  const had = lensNamed(db, slug);

  if (! had) return null;

  const next = {
    slug:       to.slug       ?? had.slug,
    name:       to.name       ?? had.name,
    note:       to.note       ?? had.note,
    definition: to.definition ?? had.definition,
  };

  try {
    db.prepare(
      `UPDATE lens SET slug = ?, name = ?, note = ?, definition = ?, updated_at = ?
        WHERE slug = ?`,
    ).run(next.slug, next.name, next.note, JSON.stringify(next.definition),
      new Date().toISOString(), slug);
  } catch {
    return null;
  }

  const saved = lensNamed(db, next.slug);

  // Only the venues whose rules this save changed; a rename or a new note changes none.
  if (saved) rebuildMembers(db, saved, had.definition);

  return saved;
};

/** Take one away, and what it let through. Says whether there was one. */
export const dropLens = (db: DatabaseSync, slug: string): boolean => {
  const had = lensNamed(db, slug);

  if (! had) return false;

  dropMembers(db, had.id!);
  db.prepare('DELETE FROM lens WHERE id = ?').run(had.id!);

  return true;
};

/**
 * What a definition says of each venue's slices: the ones it lets through, and
 * the months of each.
 *
 * **Includes minus excludes**, in no order: what any include matches, less what
 * any exclude matches (see `spansFor`). A slice nothing included is absent
 * rather than empty, and so is a venue with none.
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
 * **Two steps, because of where each dimension lives.** Market, dataset,
 * variant, grain and bundle are traits of a *slice*, and the date is the
 * *partition's* month. So the rules are folded once per slice, into the months
 * it is let through for, and each of its partitions asks whether it is inside
 * them.
 */
export const resolve = (db: DatabaseSync, definition: LensDefinition): Map<string, Partition[]> => {
  const out = new Map<string, Partition[]>();

  for (const [venue, slices] of resolveSlices(db, definition)) {
    const spans = new Map(slices.map(one => [one.slice.id, one.spans]));
    const held  = partitionsOf(db, venue).filter(one => lets(spans.get(one.sliceId) ?? [], one.month));

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
  const counts = new Map<string, LensOption>();

  /**
   * **`*` is offered what every venue publishes between them.** A rule under it
   * is about all of them, so a dataset one venue has is a dataset the rule may
   * name — it simply matches nothing at the venues without it.
   */
  const ids = venue === GLOBAL
    ? [...new Set(venues(db).map(one => one.name))].flatMap(one => venueIds(db, one))
    : venueIds(db, venue);

  for (const id of ids)
    for (const series of seriesFor(db, id)) {
      const key = [series.market, series.dataset, series.variant, series.grain].join('\u0000');
      const had = counts.get(key);

      const bucket = series.symbol === BUCKET ? 1 : 0;

      if (had) { had.series++; had.buckets += bucket; }
      else counts.set(key, {
        market: series.market, dataset: series.dataset,
        variant: series.variant, grain: series.grain, series: 1, buckets: bucket,
      });
    }

  return [...counts.values()].sort((a, b) =>
    a.market.localeCompare(b.market) || a.dataset.localeCompare(b.dataset)
    || a.variant.localeCompare(b.variant) || a.grain.localeCompare(b.grain));
};

/** The venue-wide file's name, where an instrument's would be. */
const BUCKET = '@';

/**
 * Why a lens cannot be stored, in a person's words.
 *
 * **A rule that matches nothing is the fault worth catching**, because it is
 * silent: a lens naming a dataset a venue does not publish looks exactly like one
 * whose venue has gone quiet, and the difference only shows up as an empty
 * download weeks later. Every problem names the venue and the rule's position, so
 * an editor can put it where the choice was made.
 */
export const problemsWith = (db: DatabaseSync, definition: LensDefinition): LensProblem[] => {
  const out: LensProblem[] = [];

  const known = new Set(venues(db).map(one => one.name));

  for (const [venue, rules] of Object.entries(definition.venues ?? {})) {
    if (venue === GLOBAL) {
      out.push(...faultsIn(rules, lensOptions(db, GLOBAL), venue));
      continue;
    }

    if (! known.has(venue)) {
      out.push({ venue, rule: -1, message: `No venue called '${venue}'.` });
      continue;
    }

    /**
     * **Asked of what this venue is actually read through**, which is the global
     * rules together with its own. A venue that only excludes is fine where a
     * global rule includes something, and a venue with no rules of its own is
     * simply read through the globals.
     */
    const effective = rulesFor(definition, venue);

    if (effective.length === 0)
      out.push({ venue, rule: -1,
        message: 'No rules, so this venue lets nothing through. Remove it, or add a rule.' });
    else if (! effective.some(rule => rule.effect === 'include'))
      out.push({ venue, rule: -1,
        message: 'Nothing is included, so this venue lets nothing through — '
               + 'an exclude only takes away from what an include lets in.' });

    out.push(...faultsIn(rules, lensOptions(db, venue), venue));
  }

  return out;
};

/** What is wrong with one venue's rules, against what that venue offers. */
const faultsIn = (
  rules:   readonly LensRule[],
  offered: readonly LensOption[],
  venue:   string,
): LensProblem[] => {
  const out: LensProblem[] = [];

  rules.forEach((rule, at) => {
      /**
       * **Each kind is checked as the pair it is**, so a variant is only ever
       * weighed against the dataset it was named with.
       */
      if (rule.datasets) {
        if (rule.datasets.length === 0)
          out.push({ venue, rule: at, field: 'datasets',
            message: 'An empty datasets list matches nothing. Leave it out for all of them.' });

        for (const one of rule.datasets) {
          const has = offered.filter(each => each.dataset === one.dataset);

          if (has.length === 0)
            out.push({ venue, rule: at, field: 'datasets',
              message: `${venue} publishes no ${one.dataset}.` });
          else if (one.variant !== undefined
                && ! has.some(each => each.variant === one.variant))
            out.push({ venue, rule: at, field: 'datasets',
              message: `${venue} publishes no ${one.dataset} at ${one.variant}.` });
        }
      }

      for (const [field, values] of [
        ['markets',  rule.markets],
        ['grains',   rule.grains],
      ] as const) {
        if (! values) continue;

        if (values.length === 0) {
          out.push({ venue, rule: at, field,
            message: `An empty ${field} list matches nothing. Leave it out for all of them.` });
          continue;
        }

        const has = new Set(offered.map(one => String(one[SINGULAR[field]])));
        const missing = values.filter(one => ! has.has(one));

        if (missing.length > 0)
          out.push({ venue, rule: at, field,
            message: `${venue} publishes no ${missing.join(', ')}.` });
      }

      /**
       * **A bound is a month.** A day would be a false precision — nobody
       * collects up to the 14th — and a file covering a whole month cannot be
       * halved by one, so the two ends would stop meaning the same thing.
       */
      if (rule.bundle !== undefined && rule.bundle !== 'instrument' && rule.bundle !== 'market')
        out.push({ venue, rule: at, field: 'bundle',
          message: `'${String(rule.bundle)}' is not a bundle. It is instrument or market; leave it out for both.` });

      for (const [field, bound] of [['from', rule.from], ['to', rule.to]] as const)
        if (bound !== undefined && ! /^\d{4}(0[1-9]|1[0-2])$/.test(bound))
          out.push({ venue, rule: at, field,
            message: `'${bound}' is not a month. Bounds are written yyyymm.` });

      if (rule.from && rule.to && rule.from > rule.to)
        out.push({ venue, rule: at, field: 'to',
          message: 'The end is before the start.' });

      out.push(...unevenIn(rule, at, offered, venue));
  });

  return out;
};

/**
 * Where a rule's finer filters do not hold for everything its markets and
 * datasets select.
 *
 * **A rule groups what it can, and a filter that fits only part of the group
 * drops the rest without a word.** `monthly` over two datasets of which one is
 * daily-only matches nothing of that one; a bundle over datasets of which one is
 * not published in it adds nothing there. Each is an empty selection that reads
 * later as a decision, so it is refused naming what it misses — which is what
 * says where to split the rule.
 *
 * Checked per `(market, dataset, variant)` — the unit a person groups by — so a
 * kline length without a monthly rendering is named on its own. **Only where a
 * rule names markets or datasets**: one naming neither means "everywhere this
 * applies", and asking it to list every dataset would refuse the plain reading.
 */
const unevenIn = (
  rule:    LensRule,
  at:      number,
  offered: readonly LensOption[],
  venue:   string,
): LensProblem[] => {
  const grains = rule.grains && rule.grains.length > 0 ? new Set<string>(rule.grains) : null;
  const bundle = rule.bundle;

  if (! grains && ! bundle) return [];

  if (! (rule.markets && rule.markets.length > 0) && ! (rule.datasets && rule.datasets.length > 0)) return [];

  const groups = new Map<string, LensOption[]>();

  for (const one of offered) {
    if (rule.markets && rule.markets.length > 0 && ! rule.markets.includes(one.market)) continue;

    if (rule.datasets && rule.datasets.length > 0 && ! rule.datasets.some(each =>
      each.dataset === one.dataset && (each.variant === undefined || each.variant === one.variant))) continue;

    const key = [one.market, one.dataset, one.variant].join(' ');

    groups.set(key, [...groups.get(key) ?? [], one]);
  }

  const out: LensProblem[] = [];
  const named = (keys: string[]): string => keys.map(one => one.trim()).sort().join(', ');

  if (grains) {
    const without = [...groups].filter(([, all]) => ! all.some(one => grains.has(one.grain))).map(([key]) => key);

    if (without.length > 0)
      out.push({ venue, rule: at, field: 'grains',
        message: `${[...grains].join(', ')} matches nothing of ${named(without)} — split those into a rule of their own.` });
  }

  if (bundle) {
    const held = (one: LensOption): number => (bundle === 'market' ? one.buckets : one.series - one.buckets);

    // Only in the grains the rule takes: a daily venue-wide file is nothing to a monthly rule.
    const without = [...groups]
      .filter(([, all]) => ! all.some(one => held(one) > 0 && (! grains || grains.has(one.grain))))
      .map(([key]) => key);

    const what = bundle === 'market' ? 'venue-wide file' : 'file per instrument';

    if (without.length > 0)
      out.push({ venue, rule: at, field: 'bundle',
        message: `${named(without)} ${without.length === 1 ? 'has' : 'have'} no ${what}, so the ${bundle} bundle selects nothing there — split those into a rule of their own.` });
  }

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

/** A lens that lets nothing through, which is what a new one starts as. */
const EMPTY: LensDefinition = { format: 1, venues: {} };

const SINGULAR = { markets: 'market', grains: 'grain' } as const;

const asLens = (row: LensRow): Lens => ({
  id:         row.id,
  slug:       row.slug,
  name:       row.name,
  note:       row.note,
  createdAt:  row.created_at,
  updatedAt:  row.updated_at,
  definition: read(row.definition),
});

/**
 * A stored definition, or an empty one.
 *
 * **A document that cannot be parsed lets nothing through**, which is the safe
 * direction: a lens is an allow-list, so failing closed hands back nothing rather
 * than the whole archive.
 */
const read = (text: string): LensDefinition => {
  try {
    const had = JSON.parse(text) as LensDefinition;

    return { format: had.format ?? 1, venues: months(had.venues ?? {}) };
  } catch {
    return { format: 1, venues: {} };
  }
};

/**
 * Bounds as months, whatever was stored.
 *
 * **Lenses written before a bound was a month carry a day.** Truncating on the
 * way out costs nothing, keeps them valid, and means the first save writes the
 * month — rather than an editor refusing to store a lens it did not write.
 *
 * Truncation is right in both directions: a day bound was already being read as
 * its month everywhere it was compared.
 */
const months = (venues: LensDefinition['venues']): LensDefinition['venues'] =>
  Object.fromEntries(Object.entries(venues).map(([venue, rules]) => [venue, rules.map(rule => ({
    ...rule,
    ...(rule.from ? { from: rule.from.slice(0, 6) } : {}),
    ...(rule.to   ? { to:   rule.to.slice(0, 6)   } : {}),
  }))]));
