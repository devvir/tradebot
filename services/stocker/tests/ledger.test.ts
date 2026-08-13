import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactManager } from '@tradebot/pipeline';
import type { Built } from '../src/types';

let dir: string;

vi.mock('../src/config', () => ({ default: { get sharedDir() { return dir; } } }));

const { load, record, close } = await import('../src/ledger');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ledger-')); });
afterEach(async () => { close(); await rm(dir, { recursive: true, force: true }); });

const built = (over: Partial<Built> = {}): Built => ({
  id:       'trades|bitget|spot|BTCUSDT|2018-09',
  key:      { table: 'trades', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT',
    month: '2018-09' } as Built['key'],
  inputs:   [{ path: 'a.zip', size: 100 }, { path: 'b.zip', size: 200 }],
  rows:     10,
  builtAt:  '2026-08-01T00:00:00.000Z',
  closedAt: '2026-07-31T00:00:00.000Z',
  ...over,
});

describe('what stocker records about a partition', () => {
  it('reads back exactly what was written', async () => {
    const entry = built();

    await record(entry);

    expect(await load()).toEqual(new Map([[entry.id, entry]]));
  });

  /**
   * The extras are what a shared schema cannot have a column for — an interval
   * means something to klines and nothing to anyone else — so the key is carried
   * whole rather than reassembled from the columns it is filed under.
   */
  it('keeps the extras a partition carries', async () => {
    const entry = built({
      id:  'klines|bitget|spot|BTCUSDT|1m|2020-08',
      key: { table: 'klines', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT',
        interval: '1m', month: '2020-08' } as Built['key'],
    });

    await record(entry);

    const found = await load();

    expect(found.get(entry.id)).toEqual(entry);
    expect(found.get(entry.id)!.key.interval).toBe('1m');
  });

  /**
   * The defect this prevents. A rebuild reads raw afresh, so its inputs are the
   * whole truth about the partition — accumulating instead leaves a raw file a
   * rebuild dropped still vouching for a partition it no longer feeds. bitget's
   * klines were rebuilt from one of two layouts at a time, and thirty-five
   * months read as fully normalised and were offered for eviction.
   */
  it('replaces the members on a rebuild rather than adding to them', async () => {
    await record(built({ inputs: [{ path: 'old.zip', size: 100 }] }));
    await record(built({ inputs: [{ path: 'new.zip', size: 300 }] }));

    const found = await load();

    expect(found.get('trades|bitget|spot|BTCUSDT|2018-09')!.inputs)
      .toEqual([{ path: 'new.zip', size: 300 }]);
  });

  /** One partition's members must not follow another's out of the store. */
  it('replaces only the partition being rebuilt', async () => {
    const other = built({
      id:  'trades|bitget|spot|ETHUSDT|2018-09',
      key: { table: 'trades', venue: 'bitget', market: 'spot', symbol: 'ETHUSDT',
        month: '2018-09' } as Built['key'],
    });

    await record(built());
    await record(other);
    await record(built({ inputs: [{ path: 'new.zip', size: 300 }] }));

    const found = await load();

    expect(found.get(other.id)!.inputs).toHaveLength(2);
    expect(found.get('trades|bitget|spot|BTCUSDT|2018-09')!.inputs).toHaveLength(1);
  });

  it('holds a partition built from nothing without inventing members', async () => {
    await record(built({ inputs: [] }));

    expect((await load()).get('trades|bitget|spot|BTCUSDT|2018-09')!.inputs).toEqual([]);
  });

  it('is empty before anything is recorded', async () => {
    expect(await load()).toEqual(new Map());
  });

  /**
   * The member list is the bulk of what stocker records and nothing that asks
   * "what has been built" wants to carry it, so it is its own topic and
   * therefore its own database.
   */
  it('keeps the members out of the partition topic', async () => {
    await record(built());

    const facts = new FactManager({ owner: 'stocker', root: join(dir, 'facts') });

    try {
      expect(facts.find({ topic: 'vault', fact: 'built' })).toHaveLength(1);
      expect(facts.find({ topic: 'vault:details' })).toHaveLength(2);
    } finally {
      facts.close();
    }
  });
});
