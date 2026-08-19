import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prevPeriod } from '../../../dates';
import type { DatabaseSync } from 'node:sqlite';
import type { Grain } from '../../../types';

/**
 * Plant what a venue publishes, from the CSVs beside this file.
 *
 * **For venues nothing can discover.** A listing venue is walked: its shapes and
 * its instruments are read out of the archive, and a seed would only be a stale
 * copy of what the first walk establishes anyway. okx and bitget publish no
 * listing at any layer, so what they contain has to arrive some other way — and
 * this is it. Adding a third such venue is a directory, not a migration.
 *
 * **One function for every venue, because there is nothing venue-specific left.**
 * The rows are the venue's, but the shape of them is the catalog's: `pattern.csv`
 * and `series.csv` are those two tables, column for column. Nothing here knows
 * what a bitget token is or how okx spells a futures chain, and no adapter has to
 * be consulted to read them — the pattern *is* the pattern, written out.
 *
 * See `README.md` beside this file for the format and how to change it.
 */
export const seed = (db: DatabaseSync, venue: string): void => {
  const found = db.prepare('SELECT id FROM venue WHERE name = ? AND host = \'\'')
    .get(venue) as { id: number } | undefined;

  if (! found) throw new Error(`No venue row for '${venue}' — the venues migration must run first`);

  /**
   * **The file's own numbering, mapped to whatever the table assigns.** A
   * `virtual_id` is a line's identity inside the seed and nothing more; the real
   * id belongs to the database and is not knowable until the row is written.
   */
  const ids = new Map<string, { id: number; grain: Grain }>();

  const pattern = db.prepare(
    `INSERT INTO pattern (venue_id, market, dataset, variant, pattern, grain, retired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
  );

  for (const row of rows(venue, 'pattern')) {
    const { id } = pattern.get(found.id, row.market, row.dataset, row.variant,
      row.pattern, row.grain, row.retired_at || null) as { id: number };

    ids.set(row.virtual_id!, { id, grain: row.grain as Grain });
  }

  /**
   * **No `venue_id`, because a series does not have one.** It reaches its venue
   * through its pattern, which is why `pattern_id` has to resolve and why a
   * series file cannot be read before the pattern file it points into.
   */
  const series = db.prepare(
    `INSERT INTO series (pattern_id, symbol, url_symbol, last, tip)
          VALUES (?, ?, ?, ?, ?)`,
  );

  const seen = new Map<string, string>();

  for (const row of rows(venue, 'series')) {
    const shape = ids.get(row.pattern_id!);

    if (shape === undefined)
      throw new Error(
        `${venue}/series.csv references pattern ${row.pattern_id}, which ${venue}/pattern.csv `
        + `does not define — it has ${ids.size} rows`);

    const patternId = shape.id;

    /**
     * **Two series of one pattern that spell their keys the same way are one
     * series**, so the catalog refuses the second — see `series_key`.
     *
     * A row repeated exactly says nothing new and is skipped. One that collides
     * while naming a *different* instrument is a fault in whatever generated the
     * seed: two instruments cannot both own a URL, and picking either would file
     * somebody's history under the other's name.
     */
    const spelling = row.url_symbol || row.symbol;
    const key      = patternId + ' ' + spelling;
    const had      = seen.get(key);

    if (had !== undefined) {
      if (had !== row.symbol)
        throw new Error(
          `${venue}/series.csv gives pattern ${row.pattern_id} the key "${spelling}" for both `
          + `"${had}" and "${row.symbol}" — two instruments cannot publish to one URL`);

      continue;
    }

    seen.set(key, row.symbol);

    /**
     * **A seed states a floor; the table holds a tip, and they are one period
     * apart.**
     *
     * A tip is a claim that everything at or below it has been settled, and
     * generation starts at the period *after* it. Nothing has walked a seeded
     * venue yet, so there is no settled history for a seed to claim — what it
     * actually knows is where the archive begins, which is the first period
     * worth asking about. Writing that as a tip meant every floor in the file
     * was recorded one day or one month before the thing it described, and a
     * reader had to know the off-by-one to see the number the seed meant.
     *
     * So the file says `floor` and means it, and the conversion lives here —
     * one place, at the only boundary the two languages meet.
     */
    series.run(patternId, row.symbol, row.url_symbol || null, row.last || null,
      row.floor ? prevPeriod(row.floor, shape.grain) : null);
  }

  /**
   * **Optional, and most venues have none.** A transform answers a
   * `{TRANSFORM:kind:default}` slot for one instrument; a venue whose URLs follow
   * their patterns needs no such file, and a missing one reads as no rows.
   */
  const transform = db.prepare(
    `INSERT INTO transform (venue_id, market, symbol, dataset, kind, transform, date_from, date_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows(venue, 'transform'))
    transform.run(found.id, row.market, row.symbol, row.dataset ?? '', row.kind,
      row.transform, row.date_from, row.date_to || null);
};

/**
 * The day each seed was built — **stated, because it is not derivable.**
 *
 * The newest `last` in a seed is not it: a `last` is only written where the
 * archive had already gone quiet long enough to say so, so reading the file back
 * answers a fortnight or more early and answers something other than its name.
 * Better a number somebody writes down than one that is nearly right for a
 * reason nobody remembers.
 *
 * **It must not claim more looking than the pass that built the seed did.** What
 * a reader takes from this is that the seed's author went on asking up to this
 * date and saw nothing beyond each series' `last` — so it is the day the seed
 * was written, and never later.
 *
 * Re-seeding a venue means editing its CSVs, and this sits beside them.
 */
const SEEDED_AT: Record<string, string> = {
  okx:    '20260912',

  /**
   * **Withheld while bitget's seed is experimental**, and restored the moment the
   * permanent seed ships.
   *
   * The horizon is a claim that the seeding sweep looked from each series' `last`
   * up to this day and saw nothing, so the run may jump that span. It is sound
   * for a seed built from measurements and exactly wrong for one built to *make*
   * them: this seed's bounds are the download index's word, and the index is
   * known to under-report. Honouring the horizon would have the run skip every
   * span the index was silent about — which is precisely the span the run exists
   * to check — and then report the index back to itself as confirmed.
   *
   * The under-reporting is not only about old files: the index withholds recent
   * days as well, and a sweep reading its silence as a frontier dates the seed
   * to a day the archive had already published past.
   */
  // bitget: withheld — see above.
};

/**
 * When this venue's seed was built, or `null` where it has none.
 *
 * A backfill leaves out the span between a series' newest seeded file and this
 * date, which the seeding pass already looked at — see `updatePage`. Nothing
 * else reads it, and a venue absent from the table above simply has no span to
 * leave out.
 */
export const seriesSeededAt = (venue: string): string | null => SEEDED_AT[venue] ?? null;


// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * One seed file, as rows keyed by the header.
 *
 * **Read where it sits.** `__dirname` resolves under `src/` when the tests run
 * and under `dist/` once built, and the build copies the CSVs across — so they
 * are beside this file in both cases and nothing has to know which it is in.
 *
 * **Columns are taken by name, and a column nobody reads is ignored.** That is
 * deliberate rather than incidental: a seed may carry whatever its own research
 * found useful to keep beside a row — where an archive spelling came from, which
 * sweep produced it — without every such column becoming this file's business.
 * Only the table's own columns and `floor` mean anything here. Do not add a
 * check that the header holds nothing else.
 */
const rows = (venue: string, table: string): Record<string, string>[] => {
  const path = join(__dirname, venue, `${table}.csv`);

  /**
   * **A venue may seed shapes without instruments.** A walked venue discovers
   * its own series and needs nothing here — but it cannot discover that a tree
   * has *ended*, because a missing file and a finished tree are the same answer.
   * So htx seeds patterns carrying their retirement dates and no series at all,
   * and its walk fills the rest in.
   */
  if (! existsSync(path)) return [];

  const text = readFileSync(path, 'utf8');
  const [header, ...lines] = text.trim().split('\n');
  const names = header!.split(',');

  return lines.map((line, at) => {
    const values = fields(line);

    if (values.length !== names.length)
      throw new Error(
        `${venue}/${table}.csv line ${at + 2} has ${values.length} fields, not ${names.length}`);

    return Object.fromEntries(names.map((name, i) => [name, values[i]!]));
  });
};

/**
 * One line, split on the commas that separate fields rather than the ones inside
 * them.
 *
 * **A field is quoted only where it has to be**, which is where it contains a
 * comma or a quote — okx's `400,incremental` variant and nothing else today. A
 * doubled quote inside a quoted field is one literal quote, as everywhere else
 * that writes CSV.
 */
const fields = (line: string): string[] => {
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

      continue;
    }

    if (char === '"' && value === '') { quoted = true; continue; }

    if (char === ',') { out.push(value); value = ''; continue; }

    value += char;
  }

  out.push(value);

  return out;
};
