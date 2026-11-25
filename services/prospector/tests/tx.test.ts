import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../src/catalog/tx';

/**
 * One transaction around synchronous work: what commits, what rolls back, and
 * which error the caller is told about.
 */

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');

  db.exec('CREATE TABLE t (x INTEGER)');

  return db;
};

const count = (db: DatabaseSync): number =>
  (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;

describe('inTransaction', () => {
  it('commits what the work wrote and returns what it returned', () => {
    const db = fresh();

    expect(inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');

      return 'done';
    })).toBe('done');

    expect(count(db)).toBe(1);
    expect(db.isTransaction).toBe(false);
  });

  it('rolls back what the work wrote when it throws, and rethrows that error', () => {
    const db   = fresh();
    const boom = new Error('boom');

    expect(() => inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');

      throw boom;
    })).toThrow(boom);

    expect(count(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  /**
   * **SQLite can roll back by itself**, and a second rollback then fails with
   * an error that says nothing about why. The caller is told the first.
   */
  it('surfaces the original error where SQLite has already rolled back', () => {
    const db = fresh();

    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON t WHEN new.x = 2 BEGIN SELECT RAISE(ROLLBACK, 'boom'); END`);

    expect(() => inTransaction(db, () => {
      db.exec('INSERT INTO t VALUES (1)');
      db.exec('INSERT INTO t VALUES (2)');
    })).toThrow(/^boom$/);

    expect(count(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('runs inside an open transaction when asked to join it, leaving the commit to its owner', () => {
    const db = fresh();

    db.exec('BEGIN');

    inTransaction(db, () => db.exec('INSERT INTO t VALUES (1)'), { join: true });

    expect(db.isTransaction).toBe(true);

    db.exec('ROLLBACK');

    expect(count(db)).toBe(0);
  });

  it('opens its own when joining finds none open', () => {
    const db = fresh();

    inTransaction(db, () => db.exec('INSERT INTO t VALUES (1)'), { join: true });

    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(1);
  });

  /** Not joining, it refuses before running anything, and leaves the caller's transaction open. */
  it('refuses to nest without join', () => {
    const db = fresh();
    let   ran = false;

    db.exec('BEGIN');

    expect(() => inTransaction(db, () => { ran = true; })).toThrow(/within a transaction/);
    expect(ran).toBe(false);
    expect(db.isTransaction).toBe(true);

    db.exec('ROLLBACK');
  });
});
