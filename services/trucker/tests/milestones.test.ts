import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({ default: { get dataDir() { return dir; } } }));

const { cached, load, publish, settled } = await import('../src/milestones');

const file = () => join(dir, '@meta', 'settled', 'gate.tsv');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'milestones-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('published milestones', () => {
  it('is empty, not an error, before anything has been collected', async () => {
    expect((await load('gate')).size).toBe(0);
  });

  it('writes one line per dataset and symbol, and reads it back', async () => {
    const known = await load('gate');

    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known)).toBe(true);
    expect(await publish('gate', 'spot-deals', 'ETH_USDT', '20180531', known)).toBe(true);

    expect(await readFile(file(), 'utf8'))
      .toBe('spot-deals\tBTC_USDT\t20180531\nspot-deals\tETH_USDT\t20180531\n');

    expect(await load('gate')).toEqual(new Map([
      ['spot-deals\tBTC_USDT', '20180531'],
      ['spot-deals\tETH_USDT', '20180531'],
    ]));
  });

  it('keeps the same symbol separate across datasets', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known);
    await publish('gate', 'futures_usdt-trades', 'BTC_USDT', '20190131', known);

    expect((await load('gate')).get('futures_usdt-trades\tBTC_USDT')).toBe('20190131');
    expect((await load('gate')).get('spot-deals\tBTC_USDT')).toBe('20180531');
  });

  it('says nothing when the milestone is not news', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known);

    // The same value again, and an earlier one: a milestone never retracts,
    // because a consumer may already have acted on it.
    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known)).toBe(false);
    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20180430', known)).toBe(false);

    expect((await readFile(file(), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('supersedes an earlier line when collection moves forward', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known);
    await publish('gate', 'spot-deals', 'BTC_USDT', '20191231', known);

    expect((await load('gate')).get('spot-deals\tBTC_USDT')).toBe('20191231');
  });

  it('survives a symbol carrying punctuation, which is why the format is tabs', async () => {
    const known = await load('gate');

    for (const symbol of ['BSV*(-3)-USDT', '人生K线-USDT', 'BTC USD']) {
      await publish('gate', 'spot-deals', symbol, '20200131', known);
      expect((await load('gate')).get(`spot-deals\t${symbol}`)).toBe('20200131');
    }
  });

  /**
   * The milestone is also the resume cursor, so what a sweep reads back has to
   * be exactly what it published — one record, no second copy to disagree.
   */
  it('answers where a symbol stands, and nothing for one never collected', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known);

    expect(settled(known, 'spot-deals', 'BTC_USDT')).toBe('20180531');
    expect(settled(known, 'spot-deals', 'NEVER')).toBeNull();
    expect(settled(known, 'other-dataset', 'BTC_USDT')).toBeNull();
  });

  /** Asked once per dataset — 22 times a sweep on Gate — over one file. */
  it('reads the venue file once and keeps it', async () => {
    const known = await cached('okx');

    await publish('okx', 'spot-deals', 'BTC_USDT', '20180531', known);

    expect(await cached('okx')).toBe(known);
    expect(settled(await cached('okx'), 'spot-deals', 'BTC_USDT')).toBe('20180531');
  });

  it('ignores a torn or malformed line rather than failing the read', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20180531', known);
    await (await import('node:fs/promises')).appendFile(file(), 'spot-deals\tETH_USDT');

    expect((await load('gate')).size).toBe(1);
  });
});
