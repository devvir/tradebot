import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropLens, editLens, lensNamed, putLens } from '../src/store';
import { scratch, sliceWith } from './db';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition } from '../src/types';

/**
 * A lens as a row: what comes back of what was stored, and what a write answers
 * when it cannot be made.
 */

let db: DatabaseSync;

beforeEach(() => {
  db  = scratch();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const trades: LensDefinition = { format: 1, venues: { binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }] }] } };
const books:  LensDefinition = { format: 1, venues: { binance: [{ effect: 'include', datasets: [{ dataset: 'books' }] }] } };

/** Store a definition as raw text, as if whatever wrote it had checked nothing — each time a version of its own. */
const stored = (definition: string): void => {
  putLens(db, 'raw', '', '');
  db.prepare("UPDATE lens SET definition = ?, updated_at = ? WHERE slug = 'raw'").run(definition, `raw-${++versions}`);
};

let versions = 0;

const row = (slug: string) =>
  db.prepare('SELECT partitions_through AS through, rebuilding FROM lens WHERE slug = ?').get(slug) as
    { through: number; rebuilding: number } | undefined;

/** Make every write to `lens` fail the way a full or broken disk would. */
const failingWrites = (): void => {
  db.exec(`
    CREATE TRIGGER no_insert BEFORE INSERT ON lens BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    CREATE TRIGGER no_update BEFORE UPDATE ON lens BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
  `);
};

describe('making a lens', () => {
  it('answers null where the slug is taken', () => {
    expect(putLens(db, 'cold', '', '')).not.toBeNull();
    expect(putLens(db, 'cold', 'Again', '')).toBeNull();
  });

  it('throws any other failure to write rather than calling it a taken slug', () => {
    failingWrites();

    expect(() => putLens(db, 'cold', '', '')).toThrow(/disk I\/O error/);
  });
});

describe('replacing a lens', () => {
  it('answers null where there is none, or the slug it is given is taken', () => {
    putLens(db, 'cold', '', '');
    putLens(db, 'warm', '', '');

    expect(editLens(db, 'nowhere', { name: 'x' })).toBeNull();
    expect(editLens(db, 'cold', { slug: 'warm' })).toBeNull();
  });

  it('throws any other failure to write', () => {
    putLens(db, 'cold', '', '');
    failingWrites();

    expect(() => editLens(db, 'cold', { name: 'x' })).toThrow(/disk I\/O error/);
  });

  it('marks new rules to be worked out from the start in the same write', () => {
    putLens(db, 'cold', '', '', trades);
    db.prepare("UPDATE lens SET partitions_through = 40, rebuilding = 0 WHERE slug = 'cold'").run();

    expect(editLens(db, 'cold', { definition: books })?.updating).toBe(true);
    expect(row('cold')).toEqual({ through: 0, rebuilding: 1 });
  });

  it('leaves where the working out stands for a new name or note', () => {
    putLens(db, 'cold', '', '', trades);
    db.prepare("UPDATE lens SET partitions_through = 40, rebuilding = 0 WHERE slug = 'cold'").run();

    expect(editLens(db, 'cold', { name: 'Cold', note: 'For the archive', definition: trades })?.updating).toBe(false);
    expect(row('cold')).toEqual({ through: 40, rebuilding: 0 });
  });
});

describe('removing a lens', () => {
  it('takes away the lens and what it let through', () => {
    const [partition] = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'monthly', bundle: 'instrument' }, ['202001']);
    const lens        = putLens(db, 'cold', '', '', trades)!;

    db.prepare('INSERT INTO lens_member (lens_id, partition_id) VALUES (?, ?)').run(lens.id!, partition!);

    expect(dropLens(db, 'cold')).toBe(true);
    expect(lensNamed(db, 'cold')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM lens_member').get()).toEqual({ n: 0 });
    expect(dropLens(db, 'cold')).toBe(false);
  });
});

describe('reading a stored definition', () => {
  it('reads one that does not parse as letting nothing through', () => {
    stored('not json');

    expect(lensNamed(db, 'raw')?.definition).toEqual({ format: 1, venues: {} });
  });

  it('leaves out a rule that is not one, and keeps the rules beside it', () => {
    stored(JSON.stringify({ format: 1, venues: {
      binance: [
        { effect: 'include', from: 202003 },
        { effect: 'include', datasets: [{ dataset: 'trades' }], from: '202001' },
        { effect: 'include', datasets: 'trades' },
      ],
      bybit: 'everything',
    } }));

    expect(lensNamed(db, 'raw')?.definition).toEqual({ format: 1, venues: {
      binance: [{ effect: 'include', datasets: [{ dataset: 'trades' }], from: '202001' }],
    } });
  });

  it('reports what it leaves out once for each version of a lens', () => {
    stored(JSON.stringify({ format: 1, venues: { binance: [{ effect: 'maybe' }] } }));

    lensNamed(db, 'raw');
    lensNamed(db, 'raw');

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('reads a bound longer than a month as its month', () => {
    stored(JSON.stringify({ format: 1, venues: { binance: [{ effect: 'include', from: '20200615', to: '20201231' }] } }));

    expect(lensNamed(db, 'raw')?.definition.venues['binance']).toEqual([{ effect: 'include', from: '202006', to: '202012' }]);
  });
});
