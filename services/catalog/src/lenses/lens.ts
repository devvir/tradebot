import { lastDay } from './spans';
import { dropMembers, rebuildMembers } from './members';
import { GLOBAL, rulesFor, spansFor, venuesIn } from './rules';
import { monthTotals, seriesFor, venueIds, venues } from '../queries';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Lens, LensDefinition, LensFigures, LensOption, LensProblem, LensResolved, LensRow, LensRule, LensSize, LensSlice, LensSpan,
  Series,
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

  if (saved) rebuildMembers(db, saved);

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
 * What a lens lets through: the series, and when.
 *
 * **Three steps, in this order, because of where each dimension lives.** Market,
 * dataset, variant and grain are properties of the *pattern*; the instrument is a
 * property of the *series*; the date is a property of the *file*. So this answers
 * the first two — a fold over rows already in memory — and hands back the date
 * bounds for whoever scans the large table.
 *
 * **Evaluation starts from nothing**, and each rule is applied in order to what
 * the rules before it left: `include` adds its span, `exclude` takes it away. A
 * series nothing included is absent rather than empty.
 */
export const resolve = (db: DatabaseSync, definition: LensDefinition): Map<string, LensSlice[]> => {
  const out = new Map<string, LensSlice[]>();

  for (const venue of venuesIn(db, definition)) {
    const slices = slicesFor(db, venueIds(db, venue), rulesFor(definition, venue));

    if (slices.length > 0) out.set(venue, slices);
  }

  return out;
};

/** What a definition selects, per venue: how many series, and the date spans among them. */
export const resolvedSummary = (db: DatabaseSync, definition: LensDefinition): Record<string, LensResolved> =>
  Object.fromEntries([...resolve(db, definition)].map(([venue, slices]) => [venue, {
    series: slices.length,
    spans:  [...new Set(slices.flatMap(one => one.spans.map(span => `${span.from ?? ''}..${span.to ?? ''}`)))].sort(),
  }]));

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

/**
 * The instruments a rule may name, in the venue's own spelling.
 *
 * **`*` is offered every venue's**, for the same reason its datasets are: a rule
 * about all of them may name an instrument only one of them lists.
 *
 * The bucket is left out, as it is everywhere else — it is offered on its own,
 * because no venue's instrument list contains it.
 */
export const lensInstruments = (db: DatabaseSync, venue: string): string[] => {
  const names = venue === GLOBAL
    ? [...new Set(venues(db).map(one => one.name))]
    : [venue];

  const out = new Set<string>();

  for (const name of names)
    for (const id of venueIds(db, name))
      for (const series of seriesFor(db, id))
        if (series.symbol !== BUCKET) out.add(series.symbol);

  return [...out].sort();
};

/** The venue-wide file, which is never in a venue's instrument list. */
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
     * rules and then its own. A venue whose first rule excludes is fine where a
     * global rule included something first, and a venue with no rules of its own
     * is simply read through the globals.
     */
    const effective = rulesFor(definition, venue);

    if (effective.length === 0)
      out.push({ venue, rule: -1,
        message: 'No rules, so this venue lets nothing through. Remove it, or add a rule.' });
    else if (effective[0]!.effect === 'exclude')
      out.push({ venue, rule: 0,
        message: 'The first rule excludes, so this venue lets nothing through — '
               + 'a lens starts from nothing and needs something included first.' });

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
 * daily-only matches nothing of that one; `@` over datasets of which one has no
 * venue-wide file adds nothing there. Each is an empty selection that reads
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
  const wantsBuckets = (rule.instruments ?? []).includes(BUCKET);

  if (! grains && ! wantsBuckets) return [];

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

  if (wantsBuckets) {
    // Only in the grains the rule takes: a daily venue-wide file is nothing to a monthly rule.
    const without = [...groups]
      .filter(([, all]) => ! all.some(one => one.buckets > 0 && (! grains || grains.has(one.grain))))
      .map(([key]) => key);

    if (without.length > 0)
      out.push({ venue, rule: at, field: 'instruments',
        message: `${named(without)} ${without.length === 1 ? 'has' : 'have'} no venue-wide file, so @ selects nothing there — split those into a rule of their own.` });
  }

  return out;
};

/**
 * How much a definition would put on a disk, before it is saved — the editor
 * asks on every change. A saved lens is sized off its rows instead; see
 * `savedLensSize`.
 *
 * Exact, always: a definition taking whole venues is summed off `rollup_venue`,
 * and anything narrower off `rollup_series` — see `figuresOf`. Neither reads a
 * file.
 */
export const lensSize = (db: DatabaseSync, definition: LensDefinition): LensSize => {
  const total: LensSize = { series: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 };

  /**
   * **Venue by venue, because the cheapest answer is per venue.** A lens taking a
   * whole venue between two dates is a sum over a few hundred rollup rows; one
   * naming three instruments is a handful of file reads. Adding them separately
   * lets each take the cheapest road.
   */
  for (const venue of venuesIn(db, definition)) {
    const one = lensSizeOf(db, definition, venue);

    total.series       += one.series;
    total.files        += one.files;
    total.bytes        += one.bytes;
    total.pending      += one.pending;
    total.pendingBytes += one.pendingBytes;
  }

  return total;
};

/**
 * What a lens puts on a disk from one venue — see `lensSize`.
 *
 * **`spans` is the venue's resolved scope, where the caller already holds it.**
 * Resolving reads every series of the venue and folds the rules over each, so a
 * caller holding the lens's scope passes it rather than paying for that again.
 */
export const lensSizeOf = (
  db:         DatabaseSync,
  definition: LensDefinition,
  venue:      string,
  spans?:     ReadonlyMap<number, readonly LensSpan[]>,
): LensSize => {
  const size: LensSize = { series: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 };
  const ids   = venueIds(db, venue);
  const rules = rulesFor(definition, venue);

  if (ids.length === 0) return size;

  const held = spans ?? spansOf(slicesFor(db, ids, rules));

  size.series = held.size;

  if (held.size === 0) return size;

  /**
   * **A venue nothing narrows is already added up.** `rollup_venue` holds its files
   * and bytes per month — the same rollup the surveys page reads — so this is
   * the one path whose figure cannot disagree with what the rest of the catalog
   * reports about the same venue, and they are the same question.
   */
  const whole = wholeVenue(rules);

  if (whole) {
    for (const row of monthTotals(db, ids, whole)) {
      size.files        += row.files;
      size.bytes        += row.bytes;
      size.pending      += row.pending;
      size.pendingBytes += row.pendingBytes;
    }

    return size;
  }

  const { files, bytes, pending, pendingBytes } = figuresOf(db, held);

  return { series: held.size, files, bytes, pending, pendingBytes };
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

/**
 * The months a venue's rules bound it to, where they narrow nothing else.
 *
 * **Null unless the venue is taken whole**, because `rollup_venue` holds one row
 * per month and nothing finer — it cannot be asked about a market or a dataset. Where
 * a lens takes everything between two dates, that row *is* the answer.
 */
const wholeVenue = (rules: readonly LensRule[]): { from?: string; to?: string } | null => {
  const [only] = rules;

  if (rules.length !== 1 || ! only || only.effect !== 'include') return null;

  if (only.markets || only.datasets || only.grains || only.instruments) return null;

  return {
    ...(only.from ? { from: only.from } : {}),
    ...(only.to   ? { to:   lastDay(only.to) } : {}),
  };
};

/** What one venue's rules resolve to, without walking every venue in the lens. */
const slicesFor = (
  db:    DatabaseSync,
  ids:   readonly number[],
  rules: readonly LensRule[],
): LensSlice[] => {
  const out: LensSlice[] = [];

  for (const id of ids)
    for (const series of seriesFor(db, id)) {
      const spans = spansFor(series, rules);

      if (spans.length > 0) out.push({ seriesId: series.id!, spans, shape: shapeOf(series) });
    }

  return out;
};

/** The series sharing each span, so a span is asked about once for all of them. */
const bySpan = (spans: ReadonlyMap<number, readonly LensSpan[]>): { span: LensSpan; ids: number[] }[] => {
  const groups = new Map<string, { span: LensSpan; ids: number[] }>();

  for (const [seriesId, held] of spans)
    for (const span of held) {
      const key   = `${span.from ?? ''}..${span.to ?? ''}`;
      const group = groups.get(key);

      if (group) group.ids.push(seriesId);
      else groups.set(key, { span, ids: [seriesId] });
    }

  return [...groups.values()];
};

/** Slices as a scope holds them: each series' spans, by its id. */
const spansOf = (slices: readonly LensSlice[]): Map<number, readonly LensSpan[]> =>
  new Map(slices.map(slice => [slice.seriesId, slice.spans]));

const shapeOf = (series: Series): string =>
  [series.market, series.dataset, series.variant, series.grain].join('\u0000');

/**
 * What these slices hold, off `rollup_series` — exact at any selection, without
 * reading a file: files, bytes and pending, the first and last month with a file,
 * and how many series hold one. A slice's spans are months, which is the
 * rollup's own grain, so each span is one indexed range of one series.
 *
 * **One statement per distinct span, not per series.** A lens almost always
 * gives every series it selects the same dates, so its series are grouped by
 * span and each group handed to SQLite whole: the seeks are the same, but run
 * inside one statement rather than as a round trip each — 187,403 of them on a
 * lens over two datasets, which took seconds by themselves. And one pass answers
 * every figure, where a pass per figure read the same rows three times.
 */
const figuresOf = (db: DatabaseSync, spans: ReadonlyMap<number, readonly LensSpan[]>): LensFigures => {
  const read = db.prepare(
    `SELECT COALESCE(SUM(files), 0) AS files, COALESCE(SUM(bytes), 0) AS bytes,
            COALESCE(SUM(pending), 0) AS pending, COALESCE(SUM(pending_bytes), 0) AS pendingBytes,
            MIN(CASE WHEN files > 0 THEN month END) AS first,
            MAX(CASE WHEN files > 0 THEN month END) AS last,
            COUNT(DISTINCT CASE WHEN files > 0 THEN series_id END) AS withFiles
       FROM rollup_series
      WHERE series_id IN (SELECT value FROM json_each(?)) AND month >= ? AND month <= ?`);

  const total: LensFigures = { files: 0, bytes: 0, pending: 0, pendingBytes: 0, first: null, last: null, withFiles: 0 };

  for (const { span, ids } of bySpan(spans)) {
    const one = read.get(JSON.stringify(ids), span.from ?? '000000', span.to ?? '999999') as unknown as LensFigures;

    total.files        += one.files;
    total.bytes        += one.bytes;
    total.pending      += one.pending;
    total.pendingBytes += one.pendingBytes;
    total.withFiles    += one.withFiles;

    if (one.first !== null && (total.first === null || one.first < total.first)) total.first = one.first;
    if (one.last !== null && (total.last === null || one.last > total.last)) total.last = one.last;
  }

  /**
   * **A series with two spans sits in two groups**, and adding the groups'
   * counts would count it twice. Rare, so only then is the count asked for
   * again, as the set of series it actually is.
   */
  if ([...spans.values()].some(held => held.length > 1)) total.withFiles = distinctWithFiles(db, spans);

  return total;
};

/** How many series hold a file inside their spans, each counted once. */
const distinctWithFiles = (db: DatabaseSync, spans: ReadonlyMap<number, readonly LensSpan[]>): number => {
  const read = db.prepare(
    `SELECT DISTINCT series_id AS id FROM rollup_series
      WHERE series_id IN (SELECT value FROM json_each(?)) AND month >= ? AND month <= ? AND files > 0`);

  const found = new Set<number>();

  for (const { span, ids } of bySpan(spans))
    for (const row of read.all(JSON.stringify(ids), span.from ?? '000000', span.to ?? '999999') as { id: number }[])
      found.add(row.id);

  return found.size;
};
