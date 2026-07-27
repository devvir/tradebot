import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({
  default: { get dataDir() { return dir; }, get sharedDir() { return join(dir, 'shared'); } },
}));

const { closings, load, publish, seed, tip } = await import('../src/complete');

// The published tip lives in `@shared`, not in trucker's own directory.
const file = (venue: string) => join(dir, 'shared', 'complete', `${venue}.tsv`);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'complete-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the published tip', () => {
  it('is null, not an error, before a venue has closed a month', async () => {
    expect(await tip('gate')).toBeNull();
    expect(await load('gate')).toEqual(new Map());
  });

  it('writes the month with the time it closed, and reads it back', async () => {
    expect(await publish('gate', '201802')).toBe(true);

    expect(await readFile(file('gate'), 'utf8')).toMatch(/^201802\t\d{4}-\d{2}-\d{2}T/);

    expect(await tip('gate')).toBe('201802');
  });

  /**
   * A tip is a promise a consumer acts on — stocker builds a partition, cold
   * storage cuts a tar. Retracting one would invalidate work already done.
   */
  it('never retracts, whatever order months are closed in', async () => {
    await publish('bybit', '201802');

    expect(await publish('bybit', '201802')).toBe(false);   // no advance
    expect(await publish('bybit', '201801')).toBe(false);   // nor backwards

    expect(await tip('bybit')).toBe('201802');
  });

  /**
   * The case the timestamp exists for. A month can be re-collected — a symbol
   * universe found to have been incomplete, a dataset added — and closing it
   * again must leave a mark even though the tip does not move, or nothing
   * downstream can tell that the month it built from has changed.
   */
  it('records a fresh time when a month is closed again', async () => {
    await publish('bybit', '201802');

    const first = (await closings('bybit')).get('201802');

    await new Promise(r => setTimeout(r, 2));
    await publish('bybit', '201802');

    const second = (await closings('bybit')).get('201802');

    expect(second).not.toBe(first);
    expect((await readFile(file('bybit'), 'utf8')).trim().split('\n')).toHaveLength(2);

    // Re-read from disk: the later line is the one that counts.
    expect((await load('bybit')).get('201802')).toBe(second);
  });

  it('supersedes an earlier line as the venue advances', async () => {
    await publish('htx', '201802');
    await publish('htx', '201803');

    expect(await tip('htx')).toBe('201803');
  });

  it('ignores a torn or malformed line rather than failing the read', async () => {
    await publish('okx', '201802');
    await (await import('node:fs/promises')).appendFile(file('okx'), 'garbage\n');

    expect(await tip('okx')).toBe('201802');
  });

  it('reads the venue file once and keeps it', async () => {
    await publish('binance', '201802');

    expect(await tip('binance')).toBe('201802');
    expect(await tip('binance')).toBe('201802');
  });
});

describe('seeding a tip for an archive collected before the ledger existed', () => {
  it('takes the last month that ends on or before the covered date', async () => {
    expect(await seed('kucoin', '20191231')).toBe('201912');
  });

  /** Walked to mid-month means that month is not complete — the one before is. */
  it('does not claim a month the venue is only part-way through', async () => {
    expect(await seed('bitget', '20260318')).toBe('202602');
  });

  it('leaves a standing tip alone', async () => {
    await publish('gate', '202001');

    expect(await seed('gate', '20191231')).toBeNull();
    expect(await tip('gate')).toBe('202001');
  });
});
