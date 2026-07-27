import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;

vi.mock('../src/config', () => ({ default: { get dataDir() { return dir; } } }));

const { backfill, cached, covered, load, lowest, publish } = await import('../src/coverage');

const file = (venue = 'gate') => join(dir, '@meta', 'covered', `${venue}.tsv`);

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'coverage-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('symbol coverage', () => {
  it('is empty, not an error, before anything has been looked at', async () => {
    expect((await load('gate')).size).toBe(0);
  });

  it('writes one line per dataset and symbol, and reads it back', async () => {
    const known = await load('gate');

    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20260803', known)).toBe(true);

    expect(await readFile(file(), 'utf8')).toBe('spot-deals\tBTC_USDT\t20260803\n');

    expect(covered(await load('gate'), 'spot-deals', 'BTC_USDT')).toBe('20260803');
  });

  it('answers nothing for a symbol never looked at', async () => {
    const known = await load('gate');

    expect(covered(known, 'spot-deals', 'NEVER')).toBeNull();
  });

  it('never retracts, so a consumer can act on what it read', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-deals', 'BTC_USDT', '20260803', known);

    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20260803', known)).toBe(false);
    expect(await publish('gate', 'spot-deals', 'BTC_USDT', '20250101', known)).toBe(false);

    expect((await readFile(file(), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('reads the venue file once and keeps it', async () => {
    const known = await cached('okx');

    await publish('okx', 'spot-deals', 'BTC_USDT', '20260803', known);

    expect(await cached('okx')).toBe(known);
  });

  /**
   * The point of the ledger: a delisted symbol's data stops for ever, but the
   * looking does not, and only the second answers "is this month complete".
   */
  it('advances past a milestone that has stopped moving', async () => {
    const known = await load('gate');

    await publish('gate', 'spot-trades', 'ELCBTC', '20170930', known);
    await publish('gate', 'spot-trades', 'ELCBTC', '20260803', known);

    expect(covered(await load('gate'), 'spot-trades', 'ELCBTC')).toBe('20260803');
  });
});

/** A venue each, since the cached map outlives one test's temporary directory. */
describe('seeding from existing milestones', () => {
  it('gives every collected symbol the coverage its milestone supports', async () => {
    const settled = new Map([
      ['spot-deals\tBTC_USDT', '20180531'],
      ['spot-deals\tETH_USDT', '20190131'],
    ]);

    expect(await backfill('htx', settled)).toBe(2);

    expect(await load('htx')).toEqual(settled);
  });

  it('leaves a symbol that already has coverage alone', async () => {
    const known = await cached('kucoin');

    await publish('kucoin', 'spot-deals', 'BTC_USDT', '20260803', known);

    expect(await backfill('kucoin', new Map([['spot-deals\tBTC_USDT', '20180531']]))).toBe(0);

    expect(covered(await load('kucoin'), 'spot-deals', 'BTC_USDT')).toBe('20260803');
  });

  it('writes nothing on a restart that finds the ledger already complete', async () => {
    const settled = new Map([['spot-deals\tBTC_USDT', '20180531']]);

    await backfill('bybit', settled);

    const after = await readFile(file('bybit'), 'utf8');

    expect(await backfill('bybit', settled)).toBe(0);
    expect(await readFile(file('bybit'), 'utf8')).toBe(after);
  });
});

/**
 * What seeds the published tip. It is the one number a venue-wide claim can
 * rest on, so an unwalked symbol has to sink it rather than be skipped.
 */
describe('the venue-wide floor', () => {
  const universe = new Map([
    ['spot-deals',      new Set(['BTC_USDT', 'ETH_USDT'])],
    ['spot-orderbooks', new Set(['BTC_USDT'])],
  ]);

  it('is the lowest coverage across every dataset and symbol', async () => {
    const known = await cached('binance');

    await publish('binance', 'spot-deals', 'BTC_USDT', '20260803', known);
    await publish('binance', 'spot-deals', 'ETH_USDT', '20191231', known);
    await publish('binance', 'spot-orderbooks', 'BTC_USDT', '20260803', known);

    expect(await lowest('binance', universe)).toBe('20191231');
  });

  it('is null when any symbol has never been looked at', async () => {
    const known = await cached('okx');

    await publish('okx', 'spot-deals', 'BTC_USDT', '20260803', known);
    await publish('okx', 'spot-deals', 'ETH_USDT', '20260803', known);
    // spot-orderbooks/BTC_USDT missing — the venue cannot claim any month.

    expect(await lowest('okx', universe)).toBeNull();
  });

  it('is null for a venue with no coverage at all', async () => {
    expect(await lowest('htx', universe)).toBeNull();
  });
});
