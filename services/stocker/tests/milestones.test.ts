import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactManager } from '@tradebot/pipeline';

let dir: string;

vi.mock('../src/config', () => ({ default: { get sharedDir() { return dir; } } }));

const { load } = await import('../src/milestones');

/** The collector stating which months it has finished. */
const complete = async (venue: string, months: string[]): Promise<void> => {
  const facts = new FactManager({ owner: 'trucker', root: join(dir, 'facts') });

  facts.recordAll(months.map(period => ({
    topic: 'archives' as const, venue, period, fact: 'complete',
    value: '2026-08-03T14:22:10.004Z',
  })));

  facts.close();
};

const tip = (month: string): string => month;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'complete-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the completeness gate', () => {
  it('blocks a venue that has published nothing', async () => {
    await complete('gate', [tip('201805')]);

    const m = await load();

    expect(m.covers('gate')).toBe(true);
    expect(m.covers('binance')).toBe(false);
  });

  /**
   * The tip names a month and the caller asks about a day, so the comparison is
   * against the month's last day — which is what lets a back-spilling series ask
   * for one day past its own month and wait for the next month to close.
   */
  it('is ready through the last day of the tip, and no further', async () => {
    await complete('gate', [tip('201805')]);

    const m = await load();

    expect(m.ready('gate', '20180430')).toBe(true);
    expect(m.ready('gate', '20180531')).toBe(true);
    expect(m.ready('gate', '20180601')).toBe(false);
  });

  /**
   * One venue's tip says nothing about another's. Within a venue it says
   * everything — that is the point of it being one fact rather than per symbol.
   */
  it('does not let one venue vouch for another', async () => {
    await complete('gate', [tip('202001')]);
    await complete('okx', [tip('201801')]);

    const m = await load();

    expect(m.ready('gate', '20190630')).toBe(true);
    expect(m.ready('okx', '20190630')).toBe(false);
  });

  /**
   * Whatever order the lines arrive in, the run is the same — a tip is not the
   * last line, and re-closing a month cannot lower it.
   */
  it('does not depend on the order months were written in', async () => {
    await complete('gate', [tip('201806'), tip('201805'), tip('201806')]);

    const m = await load();

    expect(m.ready('gate', '20180630')).toBe(true);
    expect(m.ready('gate', '20180701')).toBe(false);
  });

  /**
   * A month left open by a failed pass is stepped over by the months that close
   * after it, and the highest closed month then vouches for a hole beneath it.
   * bybit's tip read 202501 over open 202402 and 202405, and 2,091 partitions
   * were built from two months that were never finished.
   */
  it('stops at a hole rather than vouching for everything below the highest month', async () => {
    await complete('gate', [tip('201805'), tip('201806'), tip('201808')]);

    const m = await load();

    expect(m.ready('gate', '20180630')).toBe(true);
    expect(m.ready('gate', '20180731')).toBe(false);
    expect(m.ready('gate', '20180831')).toBe(false);
  });

  /**
   * A torn write can no longer happen — a half-written row is never committed —
   * but a period that is not a month could arrive from a finer grain, and the
   * tip is a claim about months.
   */
  it('ignores a period that is not a month', async () => {
    await complete('gate', [tip('201912'), '20191215', '2019']);

    const m = await load();

    expect(m.ready('gate', '20190630')).toBe(true);
  });

  it('treats a missing directory as nothing being ready, not as an error', async () => {
    const m = await load();

    expect(m.covers('gate')).toBe(false);
    expect(m.ready('gate', '20180131')).toBe(false);
  });

  it('handles a leap February and a 31-day month', async () => {
    await complete('gate', [tip('202002')]);
    await complete('okx', [tip('202001')]);

    const m = await load();

    expect(m.ready('gate', '20200229')).toBe(true);
    expect(m.ready('gate', '20200301')).toBe(false);
    expect(m.ready('okx', '20200131')).toBe(true);
  });
});
