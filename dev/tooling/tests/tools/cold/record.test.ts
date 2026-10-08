import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as record from '../../../src/tools/cold/shared/record';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogPartition } from '../../../src/tools/cold/shared/types';

let dir: string;
let db:  DatabaseSync;

const partition = (dataset: string, over: Partial<CatalogPartition> = {}): CatalogPartition => ({
  venue: 'gate', market: 'spot', dataset, variant: '', grain: 'daily', bundle: 'instrument',
  month: '202001', files: 3, bytes: 30, version: 'v1', ...over,
});

const name = (seq: number) => ({ remote: `gate/2020/gate-202001.00${seq}.tar`, local: `gate/gate-202001.00${seq}.tar` });

const plan = (...partitions: CatalogPartition[]): number =>
  record.planTar(db, 'archives', 'gate', '202001', name, partitions);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-record-'));
  db  = record.open(path.join(dir, 'cold.sqlite'));
});

afterEach(() => {
  record.close(db);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('planning a tar', () => {
  it('records the tar and the partitions it will hold, at their versions', () => {
    const id = plan(partition('trades'), partition('klines', { version: 'k1' }));

    expect(record.tarById(db, id)).toMatchObject({ state: 'planned', seq: 1, remote: 'gate/2020/gate-202001.001.tar', bytes: null });
    expect(record.heldIn(db, id).map(one => `${one.dataset} ${one.version}`)).toEqual(['klines k1', 'trades v1']);
  });

  /** A month gains tars as more of it is stored; none is ever renumbered. */
  it('numbers a later tar of the same venue-month after the last', () => {
    plan(partition('trades'));

    expect(record.tarById(db, plan(partition('klines')))).toMatchObject({ seq: 2, local: 'gate/gate-202001.002.tar' });
  });

  it('refuses a partition a second tar would also hold', () => {
    plan(partition('trades'));

    expect(() => plan(partition('trades'))).toThrow();
    expect(record.tarsOf(db, 'archives')).toHaveLength(1);
  });
});

describe('a partition that changed in the catalog', () => {
  /** Nothing is packed yet, so the plan is dropped and drawn again from the catalog. */
  it('has its tar forgotten where that does not exist yet, and no other', () => {
    const made = plan(partition('klines'));

    record.packed(db, made, 1000);

    const id = plan(partition('trades'));

    expect(record.dropPlanned(db, 'archives', 'gate')).toBe(1);
    expect(record.heldIn(db, id)).toEqual([]);
    expect(record.tarsOf(db, 'archives').map(tar => tar.id)).toEqual([made]);
    expect(record.heldIn(db, made)).toHaveLength(1);
  });

  it('makes a stored tar one to bring back, and keeps what it holds on record until it is corrected', () => {
    const id = plan(partition('trades'), partition('klines'));

    record.packed(db, id, 1000);
    record.stored(db, id, 'H:old');
    record.noteChange(db, record.heldIn(db, id).find(one => one.dataset === 'trades')!, partition('trades', { version: 'v2', files: 4, bytes: 40 }));

    expect(record.tarById(db, id)).toMatchObject({ state: 'stale', handle: 'H:old' });
    expect(record.heldIn(db, id).find(one => one.dataset === 'trades'))
      .toMatchObject({ version: 'v1', next: { version: 'v2', files: 4, bytes: 40 } });
    expect(record.heldIn(db, id).find(one => one.dataset === 'klines')!.next).toBeNull();
  });

  it('holds the new version once the corrected tar is stored', () => {
    const id = plan(partition('trades'));

    record.packed(db, id, 1000);
    record.stored(db, id, 'H:old');
    record.noteChange(db, record.heldIn(db, id)[0]!, partition('trades', { version: 'v2', files: 4, bytes: 40 }));
    record.applyChanges(db, id);
    record.stored(db, id, 'H:new');

    expect(record.heldIn(db, id)[0]).toMatchObject({ version: 'v2', files: 4, bytes: 40, next: null });
    expect(record.tarById(db, id)).toMatchObject({ state: 'stored', handle: 'H:new' });
  });
});

describe('what the record holds', () => {
  it('adds up tars, what is stored, and the partitions', () => {
    const one = plan(partition('trades'), partition('klines'));

    plan(partition('funding'));
    record.packed(db, one, 500);
    record.stored(db, one, 'H:1');

    expect(record.totals(db, 'archives')).toEqual({ tars: 2, stored: 1, bytes: 500, storedBytes: 500, partitions: 3 });
  });
});
