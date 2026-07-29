import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Built, RawFile } from '../src/types';

let dir: string;

vi.mock('../src/config', () => ({ default: { get sharedDir() { return dir; } } }));

const { flag } = await import('../src/mutations');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mutations-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const input = (path: string, size = 100): RawFile =>
  ({ path, size } as RawFile);

const record = (paths: string[]): Built => ({
  id:      'trades|bitget|spot|BTCUSDT|2018-09',
  key:     { table: 'trades', venue: 'bitget', market: 'spot', symbol: 'BTCUSDT', month: '2018-09' } as Built['key'],
  inputs:  paths.map(p => ({ path: p, size: 100 })),
  rows:    10,
  builtAt: '2026-08-01T00:00:00.000Z',
});

const written = () => readFile(join(dir, 'rebuilt', 'bitget.tsv'), 'utf8');

describe('flag', () => {
  /**
   * A month is built only once its collector calls it finished. When it changes
   * anyway the rebuild is automatic, but the month may already be tarred into
   * cold storage — which is a person's decision, so it has to be recorded
   * somewhere a log rotation cannot take away.
   */
  it('records a settled month that gained a file', async () => {
    await flag(record(['a.zip']), [input('a.zip'), input('b.zip')]);

    const line = await written();

    expect(line).toContain('trades\tbitget\tspot\tBTCUSDT\t2018-09\t1\tb.zip');
    expect(line).toContain('2026-08-01T00:00:00.000Z');
  });

  it('counts every file that is new, naming the first', async () => {
    await flag(record(['a.zip']), ['a', 'b', 'c', 'd'].map(n => input(`${n}.zip`)));

    expect(await written()).toContain('\t3\tb.zip\t');
  });

  /** A file whose size changed is as much a mutation as one that appeared. */
  it('treats a changed size as a change', async () => {
    await flag(record(['a.zip']), [input('a.zip', 999)]);

    expect(await written()).toContain('\t1\ta.zip\t');
  });

  /** The overwhelmingly common case: nothing changed, nothing said. */
  it('writes nothing when the inputs still match', async () => {
    await flag(record(['a.zip', 'b.zip']), [input('a.zip'), input('b.zip')]);

    await expect(written()).rejects.toThrow();
  });

  it('appends, so a second surprise does not overwrite the first', async () => {
    await flag(record(['a.zip']), [input('a.zip'), input('b.zip')]);
    await flag(record(['a.zip']), [input('a.zip'), input('c.zip')]);

    expect((await written()).trim().split('\n')).toHaveLength(2);
  });
});
