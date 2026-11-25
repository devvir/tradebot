import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admit } from '../src/members';
import { putLens } from '../src/store';
import { scratch, sliceWith } from './db';
import type { DatabaseSync } from 'node:sqlite';
import type { Lens, LensDefinition } from '../src/types';

/**
 * Taking a partition that has just been made into the lenses it belongs in, in
 * the transaction that made it.
 */

let db: DatabaseSync;

beforeEach(() => {
  db = scratch();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const everything: LensDefinition = { format: 1, venues: { '*': [{ effect: 'include' }] } };

/** A lens that has read every partition there is, as one stored and caught up. */
const caughtUp = (slug: string, definition: LensDefinition, through: number): Lens => {
  const lens = putLens(db, slug, '', '', definition)!;

  db.prepare('UPDATE lens SET partitions_through = ?, rebuilding = 0 WHERE id = ?').run(through, lens.id);

  return { ...lens, updating: false };
};

const members = (lens: Lens): number[] =>
  (db.prepare('SELECT partition_id AS id FROM lens_member WHERE lens_id = ?').all(lens.id) as { id: number }[]).map(one => one.id);

const through = (lens: Lens): number =>
  (db.prepare('SELECT partitions_through AS at FROM lens WHERE id = ?').get(lens.id) as { at: number }).at;

describe('admitting a partition', () => {
  it('takes it into the lenses that let it through', () => {
    const lens = caughtUp('all', everything, 0);
    const [id] = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'monthly', bundle: 'instrument' }, ['202001']);

    admit(db, [lens], id!);

    expect(members(lens)).toEqual([id]);
    expect(through(lens)).toBe(id);
  });

  /** One lens that cannot be evaluated must not roll back the transaction that made the partition. */
  it('leaves a lens whose rules cannot be evaluated to its catching up, and admits it to the others', () => {
    const good = caughtUp('all', everything, 0);
    const bad  = { ...caughtUp('bad', everything, 0),
      definition: { format: 1, venues: { '*': [{ effect: 'include', datasets: 'trades' }] } } as unknown as LensDefinition };

    const [id] = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'monthly', bundle: 'instrument' }, ['202001']);

    db.exec('BEGIN IMMEDIATE');
    expect(() => admit(db, [bad, good], id!)).not.toThrow();
    db.exec('COMMIT');

    expect(members(good)).toEqual([id]);
    expect(through(good)).toBe(id);

    expect(members(bad)).toEqual([]);
    expect(through(bad)).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("'bad'"));
  });
});
