import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactManager } from '@tradebot/pipeline';
import type { Fact } from '@tradebot/pipeline';
import type { Built, RawFile } from '../src/types';

let dir: string;

vi.mock('../src/config', () => ({ default: { get sharedDir() { return dir; } } }));

const { flag, close } = await import('../src/mutations');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mutations-')); });
afterEach(async () => { close(); await rm(dir, { recursive: true, force: true }); });

const input = (path: string, size = 100): RawFile =>
  ({ path, size } as RawFile);

const record = (paths: string[]): Built => ({
  id:      'trades|bitget|spot|BTCUSDT|2018-09',
  key:     { table: 'trades', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT', month: '2018-09' } as Built['key'],
  inputs:  paths.map(p => ({ path: p, size: 100 })),
  rows:    10,
  builtAt: '2026-08-01T00:00:00.000Z',
});

/** What was recorded, read back the way any consumer would ask for it. */
const written = (): Fact[] => {
  const facts = new FactManager({ owner: 'stocker', root: join(dir, 'facts') });

  try {
    return facts.find({ topic: 'logs:vault', fact: 'drifted' }, { meta: true });
  } finally {
    facts.close();
  }
};

describe('flag', () => {
  /**
   * A month is built only once its collector calls it finished. When it changes
   * anyway the rebuild is automatic, but the month may already be tarred into
   * cold storage — which is a person's decision, so it has to be recorded
   * somewhere the container's logs going away cannot take with them.
   */
  it('records a settled month that gained a file', async () => {
    await flag(record(['a.zip']), [input('a.zip'), input('b.zip')]);

    const [drift] = written();

    expect(drift).toMatchObject({
      venue: 'bitget', period: '201809', market: 'spot',
      symbol: 'BTCUSDT', dataset: 'trades', value: '1',
    });

    expect(drift!.meta).toEqual({ first: 'b.zip', builtAt: '2026-08-01T00:00:00.000Z' });
  });

  it('counts every file that is new, naming the first', async () => {
    await flag(record(['a.zip']), ['a', 'b', 'c', 'd'].map(n => input(`${n}.zip`)));

    const [drift] = written();

    expect(drift!.value).toBe('3');
    expect(drift!.meta).toMatchObject({ first: 'b.zip' });
  });

  /** A file whose size changed is as much a mutation as one that appeared. */
  it('treats a changed size as a change', async () => {
    await flag(record(['a.zip']), [input('a.zip', 999)]);

    const [drift] = written();

    expect(drift!.value).toBe('1');
    expect(drift!.meta).toMatchObject({ first: 'a.zip' });
  });

  /** The overwhelmingly common case: nothing changed, nothing said. */
  it('records nothing when the inputs still match', async () => {
    await flag(record(['a.zip', 'b.zip']), [input('a.zip'), input('b.zip')]);

    expect(written()).toEqual([]);
  });

  /**
   * Drift is an occurrence rather than a state, so a second one has to sit
   * beside the first — a partition that has drifted twice is saying something a
   * partition that drifted once is not. `seq` is what keeps them apart.
   */
  it('accumulates, so a second surprise does not replace the first', async () => {
    await flag(record(['a.zip']), [input('a.zip'), input('b.zip')]);
    await flag(record(['a.zip']), [input('a.zip'), input('c.zip')]);

    const drifts = written();

    expect(drifts).toHaveLength(2);
    expect(drifts.map(drift => (drift.meta as { first: string }).first)).toEqual(['b.zip', 'c.zip']);
    expect(new Set(drifts.map(drift => drift.seq)).size).toBe(2);
  });
});
