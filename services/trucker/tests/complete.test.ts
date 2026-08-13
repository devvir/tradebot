import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({
  default: { get dataDir() { return dir; }, get sharedDir() { return join(dir, 'shared'); } },
}));

const { closings, load, publish, seed, tip, _test_reset: reset } = await import('../src/complete');


// The in-memory copy is keyed by venue and outlives a test, so without this a
// venue reused by two tests carries the first one's months into the second.
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'complete-')); reset(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the published tip', () => {
  it('is null, not an error, before a venue has closed a month', async () => {
    expect(await tip('gate')).toBeNull();
    expect(await load('gate')).toEqual(new Map());
  });

  it('writes the month with the time it closed, and reads it back', async () => {
    expect(await publish('gate', '201802')).toBe(true);

    expect((await load('gate')).get('201802')).toMatch(/^\d{4}-\d{2}-\d{2}T/);

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

    // One fact per venue-month, so the new time replaces the old rather than
    // being appended beside it — no reader has to pick the later of two.
    expect(await load('bybit')).toEqual(new Map([['201802', second]]));
  });

  it('supersedes an earlier line as the venue advances', async () => {
    await publish('htx', '201802');
    await publish('htx', '201803');

    expect(await tip('htx')).toBe('201803');
  });

  /**
   * The defect this exists to prevent. A month that fails mid-walk is left open
   * while the months after it close, and a tip taken as the maximum then names a
   * month with a hole beneath it. Every consumer reads `month <= tip` as
   * complete: bybit's tip read 202501 over open 202402 and 202405, and stocker
   * built 2,091 partitions from two months that were never finished.
   */
  it('stops at a hole rather than reporting the highest month closed', async () => {
    for (const month of ['202401', '202403', '202404']) await publish('bybit', month);

    expect(await tip('bybit')).toBe('202401');
  });

  it('releases every month above a hole when the hole is filled', async () => {
    for (const month of ['202401', '202403', '202404']) await publish('bybit', month);

    // The frontier moves three months on one closing, so the advance cannot be
    // read from the month that was just closed.
    expect(await publish('bybit', '202402')).toBe(true);
    expect(await tip('bybit')).toBe('202404');
  });

  /**
   * A torn write is no longer possible — a half-written row is never committed —
   * but a period that is not a month could still arrive from a future grain, and
   * the tip is a claim about months.
   */
  it('ignores a period that is not a month', async () => {
    await publish('okx', '201802');
    await publish('okx', '20180301');

    expect(await tip('okx')).toBe('201802');
  });

  it('reads the venue\'s facts once and keeps them', async () => {
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
