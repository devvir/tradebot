import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({ default: { get dataDir() { return dir; } } }));

type Load = (typeof import('../src/progress'))['cachedSymbols'];

const file = () => join(dir, '@meta', 'symbols', 'v.tsv');

/**
 * A venue's file is read once and held for the life of the process, which is
 * the point of it — so a fresh import is both what isolates one case from the
 * next and what stands in for a restart.
 */
const reopened = async (): Promise<Load> => {
  vi.resetModules();

  return (await import('../src/progress')).cachedSymbols;
};

let cachedSymbols: Load;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'symbols-'));
  cachedSymbols = await reopened();
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('cachedSymbols', () => {
  it('never records an empty list — empty means the load faulted', async () => {
    const first = await cachedSymbols('v', 'd', 60, async () => []);

    expect(first).toEqual([]);
    await expect(readFile(file(), 'utf8')).rejects.toThrow();

    // The next call must reach the loader again rather than trust a bad answer.
    expect(await cachedSymbols('v', 'd', 60, async () => ['A'])).toEqual(['A']);
  });

  it('serves from memory while the stamp is fresh', async () => {
    const load = vi.fn(async () => ['A']);

    await cachedSymbols('v', 'd', 60, load);
    await cachedSymbols('v', 'd', 60, load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks the venue again once the stamp has aged out', async () => {
    const load = vi.fn(async () => ['A']);

    await cachedSymbols('v', 'd', 60, load);
    await cachedSymbols('v', 'd', 0, load);   // expired by definition

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('survives a restart without asking the venue again', async () => {
    const first = vi.fn(async () => ['A', 'B']);

    await cachedSymbols('v', 'd', 60, first);

    const load  = vi.fn(async () => ['A']);
    const again = await reopened();

    expect(await again('v', 'd', 60, load)).toEqual(['A', 'B']);
    expect(load).not.toHaveBeenCalled();
  });

  /**
   * Venues that enumerate from their live instruments API stop mentioning a
   * symbol the day it delists, while its history stays on the CDN. The union
   * with every symbol ever seen keeps those archives reachable.
   */
  it('returns the union of the live list and every symbol ever seen', async () => {
    await cachedSymbols('v', 'd', 60, async () => ['A', 'DELISTED']);

    // Restarted, and the stamp treated as expired: the live list has lost one.
    const again = await reopened();

    expect(await again('v', 'd', 0, async () => ['A', 'B'])).toEqual(['A', 'B', 'DELISTED']);
  });

  it('keeps datasets apart, and expires them independently', async () => {
    const other = vi.fn(async () => ['B']);

    await cachedSymbols('v', 'd', 60, async () => ['A']);
    await cachedSymbols('v', 'other', 60, other);

    expect(await cachedSymbols('v', 'd', 60, async () => ['Z'])).toEqual(['A']);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('appends a symbol once, however many times it is listed', async () => {
    await cachedSymbols('v', 'd', 60, async () => ['A']);
    await cachedSymbols('v', 'd', 0, async () => ['A', 'B']);

    const lines = (await readFile(file(), 'utf8')).trim().split('\n');

    expect(lines.filter(l => l === 'd\tsymbol\tA')).toHaveLength(1);
    expect(lines.filter(l => l === 'd\tsymbol\tB')).toHaveLength(1);
  });

  it('survives symbols carrying punctuation, which is why the format is tabs', async () => {
    const symbols = ['BSV*(-3)-USDT', '人生K线-USDT', 'BTC USD'];

    await cachedSymbols('v', 'd', 60, async () => symbols);

    expect(await (await reopened())('v', 'd', 60, async () => [])).toEqual([...symbols].sort());
  });

  it('ignores a torn line rather than failing the read', async () => {
    await cachedSymbols('v', 'd', 60, async () => ['A']);
    await (await import('node:fs/promises')).appendFile(file(), 'd\tsymbol');

    expect(await (await reopened())('v', 'd', 60, async () => [])).toEqual(['A']);
  });
});
