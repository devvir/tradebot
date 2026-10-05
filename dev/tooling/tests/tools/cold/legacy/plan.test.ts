import { describe, expect, it } from 'vitest';
import { CAPS, GB } from '../../../src/tools/cold/config';
import { _test_binPack as binPack, _test_group as group } from '../../../src/tools/cold/plan';
import { _test_describe as describe_ } from '../../../src/tools/cold/scan';
import type { SourceFile } from '../../../src/tools/cold/types';

const file = (over: Partial<SourceFile> = {}): SourceFile => ({
  path: 'venue=okx/market=spot/B/symbol=BTC-USDT/dataset=trades/trades.okx.spot.BTC-USDT.202405.parquet',
  bytes: 1_000, mtime: 1,
  venue: 'okx', market: 'spot', symbol: 'BTC-USDT', dataset: 'trades',
  variant: null, month: '202405', ...over,
});

const CAP_BYTES = CAPS.vault * GB;

describe('reading a partition off its path', () => {
  it('takes every attribute from the levels that name themselves', () => {
    expect(describe_('venue=okx/market=spot/B/symbol=BTC-USDT/dataset=trades/'
      + 'trades.okx.spot.BTC-USDT.202405.parquet')).toMatchObject({
      venue: 'okx', market: 'spot', symbol: 'BTC-USDT', dataset: 'trades',
      variant: null, month: '202405',
    });
  });

  /**
   * The filename gives the extras positionally as bare values — `4h` without
   * saying it is an interval — so they are read from the path, which names them.
   * That is also why a new kind of extra needs no code here.
   */
  it('keeps an extra as the key=value the path states', () => {
    expect(describe_('venue=htx/market=spot/A/symbol=AAVE-USDT/dataset=klines/interval=4h/'
      + 'klines.htx.spot.AAVE-USDT.4h.202603.parquet')).toMatchObject({
      dataset: 'klines', variant: 'interval=4h', month: '202603',
    });
  });

  /** The letter bucket is a filesystem device and names nothing. */
  it('ignores the letter bucket wherever it sits', () => {
    expect(describe_('venue=htx/market=spot/_/symbol=1INCH-USDT/dataset=trades/'
      + 'trades.htx.spot.1INCH-USDT.202603.parquet')).toMatchObject({ symbol: '1INCH-USDT' });
  });

  it('refuses anything that does not read as a partition', () => {
    expect(describe_('venue=okx/market=spot/B/symbol=BTC-USDT/dataset=trades/notes.txt')).toBeNull();
    expect(describe_('@meta/built/trades.okx.jsonl')).toBeNull();
    expect(describe_('venue=okx/stray.202405.parquet')).toBeNull();
  });
});

describe('packing a venue-month into tars', () => {
  /**
   * Pulling half an instrument's month back from cold storage is not a thing
   * anyone wants, so the symbol is the atom whatever it costs the bin.
   */
  it('never splits a symbol across two tars', () => {
    const bins = binPack([
      file({ symbol: 'BIG', bytes: CAP_BYTES * 0.6, path: 'a' }),
      file({ symbol: 'BIG', bytes: CAP_BYTES * 0.6, path: 'b' }),
      file({ symbol: 'SMALL', bytes: 10, path: 'c' }),
    ], CAP_BYTES);

    const holding = bins.filter(bin => bin.some(f => f.symbol === 'BIG'));

    expect(holding).toHaveLength(1);
    expect(holding[0]!.filter(f => f.symbol === 'BIG')).toHaveLength(2);
  });

  /** A symbol bigger than the cap is the rule working, not failing. */
  it('gives an oversized symbol a tar of its own and overshoots', () => {
    const bins = binPack([
      file({ symbol: 'HUGE', bytes: CAP_BYTES * 3, path: 'a' }),
      file({ symbol: 'TINY', bytes: 10, path: 'b' }),
    ], CAP_BYTES);

    expect(bins).toHaveLength(2);
    expect(bins.find(bin => bin[0]!.symbol === 'HUGE')![0]!.bytes).toBeGreaterThan(CAP_BYTES);
  });

  it('fills a bin rather than opening one per symbol', () => {
    const bins = binPack(
      Array.from({ length: 20 }, (_, n) =>
        file({ symbol: `S${n}`, bytes: CAP_BYTES / 10, path: `p${n}` })),
      CAP_BYTES,
    );

    expect(bins.length).toBeLessThanOrEqual(3);
  });

  /**
   * A venue may list the same symbol as spot and as perp — 477 of 6,022
   * (venue, symbol) pairs do. They are different instruments in different
   * subtrees, so fusing them would distort every bin they appear in.
   */
  it('treats one symbol on two markets as two instruments', () => {
    const groups = group([
      file({ market: 'spot', symbol: 'DOGE_USDT', path: 'a' }),
      file({ market: 'perp', symbol: 'DOGE_USDT', path: 'b' }),
    ]);

    expect(groups.size).toBe(2);
  });

  /** A re-run must produce the same bins, or a resumed plan means nothing. */
  it('packs deterministically', () => {
    const files = Array.from({ length: 12 }, (_, n) =>
      file({ symbol: `S${n % 4}`, bytes: 100 * (n + 1), path: `p${n}` }));

    expect(binPack(files, CAP_BYTES).map(bin => bin.map(f => f.path)))
      .toEqual(binPack([...files].reverse(), CAP_BYTES).map(bin => bin.map(f => f.path)));
  });
});
