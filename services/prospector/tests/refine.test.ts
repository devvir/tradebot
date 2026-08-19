import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceRun, beginJob, closeRun, establishedAt, openPartitions, putVenue, refinePartition } from '../src/catalog';
import { openCatalog } from '../src/database';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Splitting a partition while its job is open, which is the one operation that
 * can silently lose keyspace: a parent removed without its children written
 * leaves a stretch of the archive belonging to nothing, and the work list is the
 * partitions.
 */

let dir: string;
let db:  DatabaseSync;
let venueId: number;

beforeEach(() => {
  dir     = mkdtempSync(join(tmpdir(), 'refine-'));
  db      = openCatalog(join(dir, 'catalog.db'), { seedData: false });
  venueId = putVenue(db, 'binance', 'https://x', '');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const parent = (cursor: string | null) => {
  beginJob(db, venueId, 'walk', ['klines/']);

  const run = openPartitions(db, venueId, 'walk').find(one => one.scope === 'klines/')!;

  if (cursor) advanceRun(db, run.id, cursor, 1, 0);

  return openPartitions(db, venueId, 'walk').find(one => one.id === run.id)!;
};

const scopes = () => openPartitions(db, venueId, 'walk').map(one => one.scope).sort();

describe('refining a partition', () => {
  it('replaces the parent with its children', () => {
    refinePartition(db, parent(null), ['klines/A/', 'klines/B/']);

    expect(scopes()).toEqual(['klines/A/', 'klines/B/']);
  });

  it('starts every child fresh when the parent never read anything', () => {
    const made = refinePartition(db, parent(null), ['klines/A/', 'klines/B/']);

    expect(made.map(one => one.cursor)).toEqual([null, null]);
  });

  /**
   * The division the whole thing rests on. A walk is ordered, so a child sorting
   * entirely below the cursor has been read — recreating it would walk it twice,
   * and carrying the cursor into it would skip what it holds.
   */
  it('drops children already read, resumes the one holding the cursor, starts the rest fresh', () => {
    const made = refinePartition(db, parent('klines/C/x-2025-01.zip'),
      ['klines/A/', 'klines/B/', 'klines/C/', 'klines/D/', 'klines/E/']);

    expect(made.map(one => [one.scope, one.cursor])).toEqual([
      ['klines/C/', 'klines/C/x-2025-01.zip'],
      ['klines/D/', null],
      ['klines/E/', null],
    ]);
  });

  /** A cursor sitting exactly at a child's start has read nothing of it yet. */
  it('does not treat a child as read when the cursor is its first key', () => {
    const made = refinePartition(db, parent('klines/B/'), ['klines/A/', 'klines/B/']);

    expect(made.map(one => one.scope)).toEqual(['klines/B/']);
  });

  /** Every claim in a job rests on one epoch, so a child cannot invent its own. */
  it('gives children the job epoch, not the moment they were made', () => {
    const before = parent(null);
    const made   = refinePartition(db, before, ['klines/A/']);

    expect(made[0]!.started).toBe(before.started);
  });

  /**
   * A split closes the parent and hands its remaining keyspace to children. Read
   * without care, that `completed` says "this prefix is established" — claiming
   * a whole tree the moment it was divided, which is the false completeness that
   * once closed binance over keyspace nobody had walked.
   */
  it('does not call a split prefix established while its children still walk', () => {
    const before = parent('klines/C/x.zip');

    refinePartition(db, before, ['klines/C/', 'klines/D/']);

    expect(establishedAt(db, venueId, 'klines/C/some-file.zip')).toBeNull();
  });

  it('calls it established once every child has finished', () => {
    const before = parent('klines/C/x.zip');
    const made   = refinePartition(db, before, ['klines/C/', 'klines/D/']);

    for (const child of made) closeRun(db, child.id);

    expect(establishedAt(db, venueId, 'klines/C/some-file.zip')).toBe(before.started);
  });

  it('closes the parent rather than deleting what it read', () => {
    const before = parent('klines/C/x.zip');

    refinePartition(db, before, ['klines/C/']);

    const row = db.prepare('SELECT completed, requests FROM run WHERE id = ?')
      .get(before.id) as { completed: string | null; requests: number };

    expect(row.completed).not.toBeNull();
    expect(row.requests).toBe(1);
  });
});
