import { beforeEach, describe, expect, it } from 'vitest';
import { lensSize, resolvedSummary } from '../src/draft';
import { scratch, sliceWith } from './db';
import type { DatabaseSync } from 'node:sqlite';
import type { LensDefinition } from '../src/types';

/**
 * What a definition would let through, counted before it is saved: across
 * venues, grains and bundles, with preferences settled among siblings.
 */

let db: DatabaseSync;

beforeEach(() => {
  db = scratch();

  for (const name of ['binance', 'bybit', 'okx']) db.prepare('INSERT INTO venue (name) VALUES (?)').run(name);
});

/** Give a partition what it holds: its files and bytes, and how many of them are still to fetch. */
const holding = (id: number, files: number, pending: number): void => {
  db.prepare('UPDATE partition SET files = ?, bytes = ?, pending = ?, pending_bytes = ? WHERE id = ?')
    .run(files, files * 100, pending, pending * 100, id);
};

/**
 * Trades at binance monthly and daily per instrument, and monthly for the
 * whole market; a kline beside them; trades at bybit daily for the whole
 * market only; and a venue with nothing at all.
 */
const archive = (): void => {
  const [a1, a2, a3] = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'monthly', bundle: 'instrument' }, ['202001', '202002', '202003']);
  const [d2, d3, d4] = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'daily', bundle: 'instrument' }, ['202002', '202003', '202004']);
  const [m1]         = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'trades', grain: 'monthly', bundle: 'market' }, ['202001']);
  const [k1]         = sliceWith(db, { venue: 'binance', market: 'spot', dataset: 'klines', variant: '1m', grain: 'monthly', bundle: 'instrument' }, ['202001']);
  const [b1, b2]     = sliceWith(db, { venue: 'bybit', market: 'linear', dataset: 'trades', grain: 'daily', bundle: 'market' }, ['202001', '202002']);

  holding(a1!, 1, 1);
  holding(a2!, 2, 0);
  holding(a3!, 3, 3);
  holding(b1!, 4, 0);
  holding(b2!, 5, 5);

  // What the lens below leaves out, heavy enough that counting any of it shows.
  for (const id of [d2, d3, d4, m1, k1]) holding(id!, 1000, 1000);
};

/** Everything up to March 2020 in its preferred form, and none of binance's klines. */
const definition: LensDefinition = {
  format: 1,
  venues: {
    '*':     [{ effect: 'include', grain: { prefer: 'monthly' }, bundle: { prefer: 'instrument' }, to: '202003' }],
    binance: [{ effect: 'exclude', datasets: [{ dataset: 'klines' }] }],
  },
};

describe('sizing a definition', () => {
  it('sums the partitions it lets through, each month in the form it prefers among those published', () => {
    archive();

    expect(lensSize(db, definition)).toEqual({ partitions: 5, files: 15, bytes: 1500, pending: 9, pendingBytes: 900 });
  });

  it('is nothing where it lets nothing through', () => {
    archive();

    expect(lensSize(db, { format: 1, venues: {} })).toEqual({ partitions: 0, files: 0, bytes: 0, pending: 0, pendingBytes: 0 });
  });
});

describe('summarising a definition', () => {
  it('counts per venue the slices it lets any month of and the partitions it lets through, and omits a venue it lets nothing of', () => {
    archive();

    expect(resolvedSummary(db, definition)).toEqual({
      binance: { slices: 3, partitions: 3, spans: ['..202003'] },
      bybit:   { slices: 1, partitions: 2, spans: ['..202003'] },
    });
  });
});
