import { holds, lastDay, union, without } from './spans';
import { seriesFor } from './series';
import { monthTotals, venueIds, venues } from './queries';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Lens, LensDefinition, LensOption, LensProblem, LensRow, LensRule, LensSlice, LensSpan,
  Publishing,
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

  return lensNamed(db, slug);
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

  return lensNamed(db, next.slug);
};

/** Take one away. Says whether there was one. */
export const dropLens = (db: DatabaseSync, slug: string): boolean =>
  Number(db.prepare('DELETE FROM lens WHERE slug = ?').run(slug).changes) > 0;

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
 * What a venue is actually read through: the global rules, then its own.
 *
 * **Global first, and that ordering is the whole of what `*` means.** Rules
 * compose in order, so a venue's own rules see what the global ones left — which
 * is what lets a lens say *everything up to 2020, except bitget's books* in two
 * rules instead of seven.
 */
export const rulesFor = (definition: LensDefinition, venue: string): LensRule[] =>
  [...(definition.venues?.[GLOBAL] ?? []), ...(definition.venues?.[venue] ?? [])];

/** The key a lens keeps its all-venue rules under. */
export const GLOBAL = '*';

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

      if (had) had.series++;
      else counts.set(key, {
        market: series.market, dataset: series.dataset,
        variant: series.variant, grain: series.grain, series: 1,
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
  });

  return out;
};

/**
 * How much a lens would put on a disk.
 *
 * Counted where the selection is small enough to add up, estimated beyond that
 * from each series' span and what its shape's files weigh — see `COUNTABLE`.
 */
export const lensSize = (
  db:         DatabaseSync,
  definition: LensDefinition,
): { series: number; files: number; bytes: number; exact: boolean } => {
  let series = 0, files = 0, bytes = 0, exact = true;

  /**
   * **Venue by venue, because the cheapest answer is per venue.** A lens taking a
   * whole venue between two dates is a sum over a few hundred rollup rows; one
   * naming three instruments is a handful of file reads. Adding them separately
   * lets each take the cheapest road.
   */
  for (const venue of venuesIn(db, definition)) {
    const ids   = venueIds(db, venue);
    const rules = rulesFor(definition, venue);

    if (ids.length === 0) continue;

    const slices = slicesFor(db, ids, rules);

    series += slices.length;

    if (slices.length === 0) continue;

    /**
     * **A venue nothing narrows is already added up.** `month` holds its files
     * and bytes per month — the same rollup the surveys page reads — so this is
     * the one path whose figure cannot disagree with what the rest of the catalog
     * reports about the same venue, and they are the same question.
     */
    const whole = wholeVenue(rules);

    if (whole) {
      for (const row of monthTotals(db, ids, whole)) { files += row.files; bytes += row.bytes; }

      continue;
    }

    const counted = weigh(db, slices);

    files += counted.files;
    bytes += counted.bytes;
    exact  = exact && counted.exact;
  }

  return { series, files, bytes, exact };
};

/** Whether a slug is one a consumer can pass anywhere without quoting it. */
export const lensNameIsSound = (slug: string): boolean => /^[a-z0-9][a-z0-9-]{1,63}$/.test(slug);

// ── Internals ─────────────────────────────────────────────────────────────────

/** A lens that lets nothing through, which is what a new one starts as. */
const EMPTY: LensDefinition = { format: 1, venues: {} };

/** Series below which a venue's files are counted rather than estimated. */
const COUNTABLE = 400;

/** Series read in full, per shape, to weigh the rest of that shape against. */
const PER_SHAPE = 6;

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

/** What one series is let through for, after every rule has had its say. */
const spansFor = (series: Publishing, rules: readonly LensRule[]): LensSpan[] => {
  let spans: LensSpan[] = [];

  for (const rule of rules) {
    if (! matches(series, rule)) continue;

    const span = { from: rule.from ?? null, to: rule.to ?? null };

    spans = rule.effect === 'include' ? union(spans, span) : without(spans, span);
  }

  return spans;
};

/**
 * Whether a rule speaks about this series at all.
 *
 * **An absent dimension means all of it**, so a rule naming only a dataset
 * matches every market, variant, grain and instrument of it.
 */
const matches = (series: Publishing, rule: LensRule): boolean =>
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
const dataset = (kinds: LensRule['datasets'], series: Publishing): boolean =>
  kinds === undefined
  || kinds.some(one => one.dataset === series.dataset
    && (one.variant === undefined || one.variant === series.variant));

const named = (values: readonly string[] | undefined, one: string): boolean =>
  values === undefined || values.includes(one);

/**
 * The months a venue's rules bound it to, where they narrow nothing else.
 *
 * **Null unless the venue is taken whole**, because the rollup holds one row per
 * month and nothing finer — it cannot be asked about a market or a dataset. Where
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

const shapeOf = (series: Publishing): string =>
  [series.market, series.dataset, series.variant, series.grain].join('\u0000');

/**
 * What these slices hold: counted where that is affordable, weighed otherwise.
 *
 * **Weighed per shape, never across them.** A venue's series sit in discovery
 * order, so neighbours are the same shape — and a sample taken positionally over
 * the whole set is two or three shapes pretending to speak for twenty. It is
 * worse on a catalog still filling, where most series hold no files yet: where
 * the sample lands decides the answer, and the same lens read twice differed by
 * three hundred fold.
 *
 * So each shape is sampled against its own series, and a shape small enough is
 * not sampled at all.
 */
const weigh = (db: DatabaseSync, slices: readonly LensSlice[]): {
  files: number; bytes: number; exact: boolean;
} => {
  const rows = db.prepare(
    `SELECT date, size FROM file WHERE series_id = ? AND existence <> 'absent'`);

  const one = (slice: LensSlice) => {
    let files = 0, bytes = 0;

    for (const row of rows.all(slice.seriesId) as { date: string; size: number | null }[])
      if (holds(slice.spans, row.date)) { files++; bytes += row.size ?? 0; }

    return { files, bytes };
  };

  if (slices.length <= COUNTABLE) {
    let files = 0, bytes = 0;

    for (const slice of slices) { const had = one(slice); files += had.files; bytes += had.bytes; }

    return { files, bytes, exact: true };
  }

  const shapes = new Map<string, LensSlice[]>();

  for (const slice of slices) {
    const had = shapes.get(slice.shape) ?? [];

    had.push(slice);
    shapes.set(slice.shape, had);
  }

  let files = 0, bytes = 0;

  for (const mine of shapes.values()) {
    /**
     * **Spread across the shape rather than taken off its front**, since the
     * first series of a shape are the instruments it was discovered for — the
     * oldest and the busiest.
     */
    const step   = Math.max(1, Math.floor(mine.length / PER_SHAPE));
    const sample = mine.filter((_, at) => at % step === 0).slice(0, PER_SHAPE);

    let some = 0, weight = 0;

    for (const slice of sample) { const had = one(slice); some += had.files; weight += had.bytes; }

    const scale = mine.length / sample.length;

    files += Math.round(some * scale);
    bytes += Math.round(weight * scale);
  }

  return { files, bytes, exact: false };
};
