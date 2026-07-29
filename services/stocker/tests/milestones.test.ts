import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({ default: { get sharedDir() { return dir; } } }));

const { load } = await import('../src/milestones');

const complete = async (venue: string, lines: string[]): Promise<void> => {
  const path = join(dir, 'complete');

  await mkdir(path, { recursive: true });
  await writeFile(join(path, `${venue}.tsv`), lines.join('\n') + '\n');
};

const tip = (month: string): string => `${month}\t2026-08-03T14:22:10.004Z`;

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

  it('takes the highest month, so a torn write cannot lower a standing tip', async () => {
    await complete('gate', [tip('201912'), tip('201805')]);

    const m = await load();

    expect(m.ready('gate', '20190630')).toBe(true);
  });

  it('ignores a malformed line rather than failing the read', async () => {
    await complete('gate', [tip('201912'), 'garbage', '\t\t']);

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
