import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIDTH, prevPeriod } from '../../../dates';
import { BUCKET } from '../../../canonical';
import { grainOf } from '../../../catalog/series';
import { INSTRUMENT_OF, SLICE_OF } from '../../schema';
import type { DatabaseSync } from 'node:sqlite';
import type { Grain } from '../../../types';

/**
 * Plant what a venue's seed directory states: `<dir>/<venue>/*.csv`.
 *
 * **A seed states what reading the archive cannot establish.** That is one of
 * two things:
 *
 * - **Series**, for a venue that publishes no listing at any layer: every key it
 *   serves has to be built from a series already held, so its patterns and
 *   series arrive here, with `transform.csv` where its URLs need one.
 * - **Retirements**, for a venue that is walked: a walk finds its shapes and
 *   instruments itself, but cannot tell a tree that has ended from one that is
 *   only quiet, so a seed of `pattern.csv` alone carries each shape's
 *   `retired_at` and the walk fills in the rest.
 *
 * Adding a venue is a directory and a one-line migration calling
 * `seed(db, '<venue>')`.
 *
 * **One function for every venue, because there is nothing venue-specific here.**
 * The rows are the venue's, but the shape of them is the catalog's: `pattern.csv`,
 * `series.csv` and `transform.csv` are those tables, column for column. Nothing
 * here knows what a venue's tokens mean, and no adapter has to be consulted to
 * read them — the pattern *is* the pattern, written out.
 *
 * `dir` holds one directory per venue, and is the directory beside this file
 * unless given. See `README.md` beside this file for the format.
 */
export const seed = (db: DatabaseSync, venue: string, dir: string = __dirname): void => {
  const found = db.prepare('SELECT id FROM venue WHERE name = ? AND host = \'\'')
    .get(venue) as { id: number } | undefined;

  if (! found) throw new Error(`No venue row for '${venue}' — the core migration must run first`);

  /**
   * **The file's own numbering, mapped to whatever the table assigns.** A
   * `virtual_id` is a line's identity inside the seed and nothing more; the real
   * id belongs to the database and is not knowable until the row is written.
   */
  const ids = new Map<string, { id: number; grain: Grain; bundle: string }>();

  const slice = db.prepare(SLICE_OF);

  const pattern = db.prepare(
    `INSERT INTO pattern (venue_id, slice_id, pattern, retired_at, holds)
          VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
  );

  rows(dir, venue, 'pattern').forEach((row, at) => {
    /**
     * **The grain is the pattern's, read off its slots**, as it is wherever a
     * pattern is met. A seed stating another would plant a shape the walk that
     * later meets it cannot recognise as the same one.
     */
    const grain = grainOf(row.pattern!);

    if (row.grain && row.grain !== grain)
      throw new Error(
        `${venue}/pattern.csv gives pattern ${row.virtual_id} the grain "${row.grain}", `
        + `and its slots say "${grain}"`);

    if (row.retired_at && ! STAMP.test(row.retired_at))
      throw new Error(
        `${venue}/pattern.csv line ${at + 2}: retired_at "${row.retired_at}" is not a date stamp`);

    /**
     * **A shape with no place for an instrument's name holds a whole market**,
     * and one with a place holds one instrument. `bundle` says otherwise where
     * a pattern has to.
     */
    const bundle = row.bundle || (row.pattern!.includes('{SYMBOL}') ? 'instrument' : 'market');

    const held = slice.get(found.id, row.market, row.dataset, row.variant, grain, bundle) as { id: number };

    const { id } = pattern.get(found.id, held.id, row.pattern,
      row.retired_at || null, row.holds || 'instrument') as { id: number };

    ids.set(row.virtual_id!, { id, grain, bundle });
  });

  /**
   * **No `venue_id`, because a series does not have one.** It reaches its venue
   * through its pattern, which is why `pattern_id` has to resolve and why a
   * series file cannot be read before the pattern file it points into.
   */
  const series = db.prepare(
    `INSERT INTO series (pattern_id, instrument_id, url_symbol, last, tip)
          VALUES (?, ?, ?, ?, ?)`,
  );

  /** A seed names an instrument by its symbol; the table holds the instrument. */
  const instrument = db.prepare(INSTRUMENT_OF);

  const seen = new Map<string, Record<string, string>>();

  rows(dir, venue, 'series').forEach((row, at) => {
    const shape = ids.get(row.pattern_id!);

    if (shape === undefined)
      throw new Error(
        `${venue}/series.csv references pattern ${row.pattern_id}, which ${venue}/pattern.csv `
        + `does not define — it has ${ids.size} rows`);

    const patternId = shape.id;

    /** A bound of another width would be read at another grain than its series'. */
    for (const column of ['floor', 'last'] as const) {
      const value = row[column];

      if (value && ! (/^\d+$/.test(value) && value.length === WIDTH[shape.grain]))
        throw new Error(
          `${venue}/series.csv line ${at + 2}: ${column} "${value}" is not a ${shape.grain} `
          + `stamp of ${WIDTH[shape.grain]} digits`);
    }

    /**
     * **Two series of one pattern that spell their keys the same way are one
     * series**, so the catalog refuses the second — see `series_key`.
     *
     * A row repeated exactly says nothing new and is skipped. One that collides
     * while saying anything else is a fault in whatever generated the seed: two
     * instruments cannot both own a URL, and one series cannot have two sets of
     * bounds — picking either would file somebody's history under the wrong one.
     */
    const spelling = row.url_symbol || row.symbol;
    const key      = patternId + ' ' + spelling;
    const had      = seen.get(key);

    if (had !== undefined) {
      if (had.symbol !== row.symbol)
        throw new Error(
          `${venue}/series.csv gives pattern ${row.pattern_id} the key "${spelling}" for both `
          + `"${had.symbol}" and "${row.symbol}" — two instruments cannot publish to one URL`);

      const differs = SERIES_COLUMNS.filter(column => (had[column] ?? '') !== (row[column] ?? ''));

      if (differs.length > 0)
        throw new Error(
          `${venue}/series.csv line ${at + 2} repeats pattern ${row.pattern_id}'s "${spelling}" `
          + `with a different ${differs.join(', ')}`);

      return;
    }

    seen.set(key, row);

    /** A series in the wrong bundle would be filed under a slice it does not belong to. */
    if ((row.symbol === BUCKET) !== (shape.bundle === 'market'))
      throw new Error(
        `${venue}/series.csv names "${row.symbol}" under pattern ${row.pattern_id}, `
        + `whose files hold ${shape.bundle === 'market' ? 'a whole market' : 'one instrument'}`);

    const held = row.symbol === BUCKET ? null
      : (instrument.get(patternId, row.symbol!) as { id: number }).id;

    /**
     * **A seed states a floor; the table holds a tip, one period below it.** The
     * floor is the first period worth asking about, and generation starts at the
     * period after a tip, so the tip planted is `prevPeriod(floor, grain)`.
     */
    series.run(patternId, held, row.url_symbol || null, row.last || null,
      row.floor ? prevPeriod(row.floor, shape.grain) : null);
  });

  /**
   * **Optional, and most venues have none.** A transform answers a
   * `{TRANSFORM:kind:default}` slot for one instrument; a venue whose URLs follow
   * their patterns needs no such file, and a missing one reads as no rows.
   */
  const transform = db.prepare(
    `INSERT INTO transform (venue_id, market, symbol, dataset, kind, transform, date_from, date_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  rows(dir, venue, 'transform').forEach((row, at) => {
    for (const column of ['date_from', 'date_to'] as const) {
      const value = row[column];

      if ((value || column === 'date_from') && ! STAMP.test(value ?? ''))
        throw new Error(
          `${venue}/transform.csv line ${at + 2}: ${column} "${value ?? ''}" is not a date stamp`);
    }

    transform.run(found.id, row.market, row.symbol, row.dataset ?? '', row.kind,
      row.transform, row.date_from, row.date_to || null);
  });
};

/**
 * The day each series seed was built — **stated, because the rows do not carry
 * it.** The newest `last` in a seed is the newest file that answered, and the
 * pass that built the seed went on asking past it up to the day it ran.
 *
 * **It must not claim more looking than that pass did.** A reader takes it to
 * mean the pass asked every series above its `last` up to this date and saw
 * nothing, so it is the day the pass ran, and never later.
 *
 * Re-seeding a venue means editing its CSVs and this entry together.
 */
const SEEDED_AT: Record<string, string> = {
  okx:    '20260912',

  /**
   * **Measured, not taken from the download index**, which both omits files
   * that exist and withholds recent days (see `docs/venues/BITGET.md`). Each
   * `last` is the newest period that answered when the pass asked every series
   * from its newest known file up to the frontier.
   */
  bitget: '20260922',
};

/**
 * The date the venue's series seed was built, or `null` where it has none.
 *
 * Up to this date the seeding pass already asked above every series' newest
 * seeded file and found nothing.
 */
export const seriesSeededAt = (venue: string): string | null => SEEDED_AT[venue] ?? null;


// ── Internals ─────────────────────────────────────────────────────────────────

/** A date stamp at any grain: `yyyymm`, `yyyymmdd`, `yyyymmddhh` or `yyyymmddhhmi`. */
const STAMP = /^\d{6}(\d{2}){0,3}$/;

/** What a series row says, beyond the key it is filed under. */
const SERIES_COLUMNS = ['symbol', 'url_symbol', 'last', 'floor'] as const;

/**
 * One seed file, as rows keyed by the header. **A missing file reads as no
 * rows**, which is how a venue seeds one table and not another.
 *
 * The shipped seeds sit beside this file: `__dirname` resolves under `src/` when
 * the tests run and under `dist/` once built, and the build copies the CSVs
 * across.
 */
const rows = (dir: string, venue: string, table: string): Record<string, string>[] => {
  const path = join(dir, venue, `${table}.csv`);

  if (! existsSync(path)) return [];

  return parseCsv(readFileSync(path, 'utf8'), `${venue}/${table}.csv`);
};

/**
 * A CSV file's text, as rows keyed by its header; `label` names the file in
 * every refusal.
 *
 * **Line endings are `\n` or `\r\n`, and a leading byte-order mark is not
 * data.** Header names are trimmed. Trailing blank lines end the file; a blank
 * line anywhere before them is refused, as is a row whose field count differs
 * from the header's. A field spans one line.
 *
 * **Columns are taken by name, and a column nobody reads is ignored.** That is
 * deliberate rather than incidental: a seed may carry whatever its own research
 * found useful to keep beside a row — where an archive spelling came from, which
 * sweep produced it — without every such column becoming the reader's business.
 * Do not add a check that the header holds nothing else.
 */
export const parseCsv = (text: string, label: string): Record<string, string>[] => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length === 0) throw new Error(`${label} has no header`);

  const names = fields(lines[0]!, label, 1).map(name => name.trim());

  return lines.slice(1).map((line, at) => {
    const number = at + 2;

    if (line === '') throw new Error(`${label} line ${number} is empty`);

    const values = fields(line, label, number);

    if (values.length !== names.length)
      throw new Error(
        `${label} line ${number} has ${values.length} fields, not ${names.length}`);

    return Object.fromEntries(names.map((name, i) => [name, values[i]!]));
  });
};

/**
 * One line, split on the commas that separate fields rather than the ones inside
 * them.
 *
 * **A field is quoted where it has to be**, which is where it contains a comma or
 * a quote. Inside a quoted field a doubled quote is one literal quote; the field
 * ends at a lone quote, which must be followed by a comma or the end of the line.
 * A quote inside an unquoted field is an ordinary character.
 */
const fields = (line: string, label: string, number: number): string[] => {
  const out: string[] = [];

  let value  = '';
  let quoted = false;

  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;

    if (quoted) {
      if (char !== '"') { value += char; continue; }

      // A doubled quote is an escaped one; a lone quote closes the field.
      if (line[at + 1] === '"') { value += '"'; at++; continue; }

      quoted = false;

      if (at + 1 < line.length && line[at + 1] !== ',')
        throw new Error(`${label} line ${number}: text after a closing quote`);

      continue;
    }

    if (char === '"' && value === '') { quoted = true; continue; }

    if (char === ',') { out.push(value); value = ''; continue; }

    value += char;
  }

  if (quoted) throw new Error(`${label} line ${number}: unterminated quote`);

  out.push(value);

  return out;
};
