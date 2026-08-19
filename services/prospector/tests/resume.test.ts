import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearUpdate, openPartitions, putVenue, recordSeries, updateStarted } from '../src/catalog';
import { openCatalog } from '../src/database';
import { surveyVenue } from '../src/survey';
import { s3 } from '../src/scanners/s3';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, Config, Found } from '../src/types';

/**
 * Picking an update up where it stopped.
 *
 * **Generation records itself; probing does not need to.** A partition per
 * series is closed as its keys are written, and `wip` is the whole of what
 * probing has left to do — so a restart honours the first and drains the second.
 * What ends a pass is reconciliation deleting the rows, which is why their
 * existence is the signal that one did not finish.
 */
let dir: string;
let db:  DatabaseSync;
let id:  number;

const config: Config = { catalogDir: '', venues: [], concurrency: 4 };

const venue: Adapter = {
  name:       'fake',
  scanner:    s3,
  list:       'https://x',
  base:       'https://x',
  root:       '',
  getContext: async () => ({}),
  dateOf:     (path) => /(\d{8})/.exec(path)?.[1] ?? null,
};

const found = (symbol: string): Found =>
  ({ market: 'spot', dataset: 'trades', symbol, pattern: 'x/{YYYY}{MM}{DD}/{SYMBOL}.zip' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resume-'));
  db  = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  id  = putVenue(db, 'fake', 'https://x', '');

  for (const symbol of ['AAA', 'BBB', 'CCC'])
    recordSeries(db, id, found(symbol), { tip: '20260720', first: '20240101' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const partitions = () => openPartitions(db, id, 'update').filter(one => one.scope !== '');

describe('what an update leaves behind', () => {
  /**
   * **Generation being done is not the pass being done.** The keys are in `wip`
   * and mostly unasked; closing the record here is what made a restart during
   * the drain plan the whole pass again.
   */
  it('keeps its rows after every partition has finished', async () => {
    const pass = await surveyVenue(db, venue, config, 'partial');

    expect(pass.generated).toBe(true);
    expect(partitions()).toHaveLength(0);
    expect(updateStarted(db, id)).not.toBeNull();
  });

  it('records one finished partition per series', async () => {
    await surveyVenue(db, venue, config, 'partial');

    const rows = db.prepare(
      `SELECT COUNT(*) AS n FROM run WHERE venue_id = ? AND kind = 'update' AND scope <> ''`,
    ).get(id) as { n: number };

    expect(rows.n).toBe(3);
  });

  /**
   * **A resumed pass generates nothing it already generated.** Every series is
   * on record as finished, so the second call has no partition to sweep — which
   * is the whole point of keeping the rows.
   */
  it('generates nothing a second time', async () => {
    const first  = await surveyVenue(db, venue, config, 'partial');
    const second = await surveyVenue(db, venue, config, 'partial');

    expect(first.found).toBeGreaterThan(0);
    expect(second.found).toBe(0);
    expect(second.partitions).toBe(0);
  });

  /**
   * **Once per series: not zero, not twice.** A row is written for every series
   * when the pass is planned and closed as that series' keys are written, so a
   * kill leaves the finished ones closed and the rest open. A resume sweeps
   * exactly the rest.
   */
  it('generates what the interrupted pass had not reached, and only that', async () => {
    await surveyVenue(db, venue, config, 'partial');

    const first = db.prepare(
      `SELECT found FROM run WHERE venue_id = ? AND kind = 'update' AND scope <> ''`,
    ).all(id) as { found: number }[];

    // What a kill looks like: one series never finished generating.
    const stopped = db.prepare(
      `SELECT id FROM run WHERE venue_id = ? AND kind = 'update' AND scope <> '' LIMIT 1`,
    ).get(id) as { id: number };

    db.prepare(`UPDATE run SET completed = NULL, cursor = NULL, found = 0 WHERE id = ?`)
      .run(stopped.id);

    expect(partitions()).toHaveLength(1);

    const resumed = await surveyVenue(db, venue, config, 'partial');

    expect(resumed.partitions).toBe(1);
    expect(resumed.found).toBe(first[0]!.found);
    expect(partitions()).toHaveLength(0);
  });

  /**
   * **The per-series rows go; the job row is closed and kept.** `run` is a
   * progress table, not a log — a venue's pass adds one row per series, and
   * keeping thirty-nine thousand of them to record that a pass happened would
   * grow the table by that much a day for a fact one row already states.
   */
  it('drops the per-series rows and keeps one row for the pass', async () => {
    await surveyVenue(db, venue, config, 'partial');

    expect(clearUpdate(db, id)).toBe(3);
    expect(updateStarted(db, id)).toBeNull();

    const left = db.prepare(
      `SELECT scope, completed FROM run WHERE venue_id = ? AND kind = 'update'`,
    ).all(id) as { scope: string; completed: string | null }[];

    expect(left).toHaveLength(1);
    expect(left[0]!.scope).toBe('');
    expect(left[0]!.completed).not.toBeNull();
  });
});

describe('an update older than the interval between them', () => {
  /**
   * **There is no such thing as too old to resume.** An open job with nothing
   * working it is what a killed container leaves and what a pause leaves, and
   * whatever its age, picking it up continues from its cursors — judging a
   * paused pass stale is the person's call, and `refresh` is how they make it.
   *
   * This is the exact shape that used to be discarded: a pass whose start is
   * years in the past, with its partitions untouched.
   */
  it('is picked up, and sweeps only what it had not reached', async () => {
    await surveyVenue(db, venue, config, 'partial');

    // What a kill leaves: one series never finished generating.
    const stopped = db.prepare(
      `SELECT id FROM run WHERE venue_id = ? AND kind = 'update' AND scope <> '' LIMIT 1`,
    ).get(id) as { id: number };

    db.prepare(`UPDATE run SET completed = NULL, cursor = NULL, found = 0 WHERE id = ?`)
      .run(stopped.id);

    db.prepare(`UPDATE run SET started = '2020-01-01T00:00:00.000Z' WHERE venue_id = ?`).run(id);

    expect(Date.now() - Date.parse(updateStarted(db, id)!)).toBeGreaterThan(100 * 86_400_000);

    const resumed = await surveyVenue(db, venue, config, 'partial');

    // One partition, not three: the pass was continued rather than replanned.
    expect(resumed.partitions).toBe(1);
    expect(updateStarted(db, id)).toBe('2020-01-01T00:00:00.000Z');
    expect(partitions()).toHaveLength(0);
  });
});
