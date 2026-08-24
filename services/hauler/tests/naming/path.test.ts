import { describe, expect, it } from 'vitest';
import { filenameOf, nameOf, partitionOf, pathOf } from '../../src/naming';
import type { Offered } from '../../src/types';

/**
 * Where a file lands, and what it is called once it is there.
 *
 * **Nothing here translates.** The catalog answers in the vocabulary the
 * archives are arranged by, so naming is those fields put in order — and the
 * only judgement left is refusing what cannot be placed rather than inventing a
 * directory for it.
 */

const offered = (over: Partial<Offered>): Offered => ({
  key: 'k', url: 'https://example.invalid/f', venue: 'bitget', market: 'perp',
  dataset: 'klines', variant: { interval: '1m' }, symbol: 'BTCUSDT', date: '20250601',
  ext: '.zip', ...over,
});

describe('nameOf', () => {
  it('takes the canonical fields as they arrive', () => {
    expect(nameOf(offered({}))).toEqual({
      venue: 'bitget', market: 'perp', dataset: 'klines,1m',
      symbol: 'BTCUSDT', period: '20250601', ext: '.zip',
    });
  });

  /**
   * The variant is one string however many levels it holds, so a book's depth
   * and its mode arrive together and stay together.
   */
  it('keeps a multi-level variant whole', () => {
    expect(nameOf(offered({ dataset: 'books', variant: { depth: '400', mode: 'incremental' } })).dataset)
      .toBe('books,400,incremental');
  });

  it('names a dataset with no variant by the dataset alone', () => {
    const named = nameOf(offered({ dataset: 'trades', variant: undefined }));

    expect(named.dataset).toBe('trades');
  });

  /**
   * `@` is the catalog's own name for a file carrying every instrument of a
   * market, and it arrives that way rather than being inferred here.
   */
  it('files a venue-wide bucket under the symbol the catalog gave it', () => {
    expect(nameOf(offered({ symbol: '@', dataset: 'funding', variant: { kind: 'realised' } })).symbol)
      .toBe('@');
  });

  it('carries a part where a period is split across files', () => {
    expect(nameOf(offered({ part: '101' })).part).toBe('101');
    expect(nameOf(offered({})).part).toBeUndefined();
  });
});

/**
 * **A name invented here becomes a directory, and a directory becomes something
 * a reader trusts.** So anything hauler cannot place is refused rather than
 * approximated — a gap between the two services, not a fault of the venue's.
 */
describe('what it refuses', () => {
  it('refuses a market outside the vocabulary', () => {
    expect(() => nameOf(offered({ market: 'SWAP' }))).toThrow(/not a market/);
    expect(() => nameOf(offered({ market: 'futures_usdt' }))).toThrow(/not a market/);
  });

  it('refuses a dataset outside the vocabulary', () => {
    expect(() => nameOf(offered({ dataset: 'candlesticks_5m' }))).toThrow(/not a dataset/);
  });

  /**
   * An empty symbol means the catalog could not place the file in a series —
   * which is not the same claim as `@`, and must not be filed as though it were.
   */
  it('refuses a file the catalog could not place, rather than calling it a bucket', () => {
    expect(() => nameOf(offered({ symbol: '' }))).toThrow(/no symbol/);
  });
});

describe('where it lands', () => {
  it('puts the whole identity in the filename and the month in the path', () => {
    const named = nameOf(offered({}));

    expect(filenameOf(named)).toBe('bitget|perp|klines,1m|BTCUSDT|20250601.zip');
    expect(pathOf('/data/archives', named))
      .toBe('/data/archives/bitget/perp/klines,1m/202506/B/BTCUSDT/'
        + 'bitget|perp|klines,1m|BTCUSDT|20250601.zip');
  });

  it('files a symbol that does not start with a letter under _', () => {
    const named = nameOf(offered({ symbol: '1000PEPEUSDT' }));

    expect(pathOf('/a', named)).toContain('/202506/_/1000PEPEUSDT/');
  });

  it('places a part between the period and the extension', () => {
    expect(filenameOf(nameOf(offered({ part: '002' }))))
      .toBe('bitget|perp|klines,1m|BTCUSDT|20250601|002.zip');
  });
});

describe('the partition', () => {
  it('is one directory, whatever grain the files are at', () => {
    const daily   = partitionOf(nameOf(offered({ date: '20250601' })));
    const monthly = partitionOf(nameOf(offered({ date: '202506' })));

    expect(daily).toEqual({ venue: 'bitget', market: 'perp', dataset: 'klines,1m',
      month: '202506' });
    expect(monthly).toEqual(daily);
  });

  /** Two variants of one dataset are two partitions, and complete separately. */
  it('separates the variants of one dataset', () => {
    const minute = partitionOf(nameOf(offered({ variant: { interval: '1m' } })));
    const hour   = partitionOf(nameOf(offered({ variant: { interval: '1h' } })));

    expect(minute.dataset).toBe('klines,1m');
    expect(hour.dataset).toBe('klines,1h');
  });
});
