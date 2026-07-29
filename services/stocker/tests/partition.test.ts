import { describe, expect, it } from 'vitest';
import { monthOf } from '../src/dates';
import { _test_changed as changed, _test_sizeOf as sizeOf } from '../src/scan';
import { dirOf, fileNameOf, idOf, keyOf, labelOf } from '../src/partition';
import type { Built, PartitionKey, RawFile, Series } from '../src/types';

const series = (over: Partial<Series> = {}): Series => ({
  source: 'trucker', venue: 'okx', table: 'trades', market: 'perp',
  match: /(?<symbol>x)/, container: 'zip', format: 'csv', header: true,
  project: {}, ts: 't', ...over,
});

const file = (over: Partial<RawFile> = {}): RawFile => ({
  path: 'p/a.zip', absolute: '/raw/okx/p/a.zip', series: series(),
  rawSymbol: 'BTC-USDT-SWAP', month: '2026-06', size: 10, ...over,
});

describe('reading the date out of a filename', () => {
  it('handles every shape the origins use, longest first', () => {
    expect(monthOf('BTCUSDT-trades-2026-07-24.zip')).toBe('2026-07');
    expect(monthOf('20260724/BTC-USDT-SWAP-trades-2026-07-24.zip')).toBe('2026-07');
    expect(monthOf('BTCUSDT-trades-2026-07.zip')).toBe('2026-07');
    expect(monthOf('spot/deals/202607/BTC_USDT-202607.csv.gz')).toBe('2026-07');
    expect(monthOf('BTC_USD-2026072716.csv.gz')).toBe('2026-07');
  });

  it('returns null when nothing dates the file', () => {
    expect(monthOf('README.md')).toBeNull();
  });
});

describe('partition identity', () => {
  /**
   * Two files belong together when and only when they produce the same key.
   * Gate publishes a day of books as 24 hourly files and Bitget a day of trades
   * as numbered parts; all of them must land in one partition.
   */
  it('groups every file of a month under one id', () => {
    const a = idOf(keyOf(file({ path: 'x/2026-06-01.zip' })));
    const b = idOf(keyOf(file({ path: 'x/2026-06-02.zip' })));

    expect(a).toBe(b);
  });

  /**
   * The bug this exists to prevent. Gate publishes funding twice — what was
   * charged (3 rows a day) and the running estimate (1,440) — and while `kind`
   * was a projected *column* both series computed the same partition id. Each
   * sweep rebuilt the partition from whichever the walk reached last, so all
   * 757 gate funding partitions held half their data, alternating which half.
   */
  it('separates realised from predicted funding', () => {
    const realised  = keyOf(file({ series: series({
      venue: 'gate', table: 'funding', kind: 'realised' }) }));
    const predicted = keyOf(file({ series: series({
      venue: 'gate', table: 'funding', kind: 'predicted' }) }));

    expect(idOf(realised)).not.toBe(idOf(predicted));
    expect(dirOf(realised)).not.toBe(dirOf(predicted));
    expect(fileNameOf(realised)).not.toBe(fileNameOf(predicted));
  });

  it('puts kind in the path, the name and the label', () => {
    const key = keyOf(file({ series: series({
      venue: 'gate', table: 'funding', kind: 'predicted' }) }));

    expect(dirOf(key)).toContain('/dataset=funding/kind=predicted');
    expect(fileNameOf(key)).toContain('.predicted.');
    expect(labelOf(key)).toContain('predicted');
    expect(idOf(key)).toContain('predicted');
  });

  it('separates interval and variant into different partitions', () => {
    const base = keyOf(file({ series: series({ table: 'klines' }) }));

    expect(idOf({ ...base, interval: '1m' })).not.toBe(idOf({ ...base, interval: '1h' }));
    expect(idOf({ ...base, variant: '400lv' })).not.toBe(idOf({ ...base, variant: '5000lv' }));
  });

  it('lays out hive directories and a descriptive file name', () => {
    const key: PartitionKey = {
      table: 'orderBook', venue: 'okx', market: 'perp',
      symbol: 'BTCUSDT', variant: '400lv', month: '2026-06',
    };

    // Venue first, so a venue is one directory to move, back up or evict. An
    // engine harvests `key=value` from any position, so the order is chosen for
    // handling rather than for querying.
    expect(dirOf(key))
      .toContain('venue=okx/market=perp/B/symbol=BTCUSDT/dataset=orderBook/variant=400lv');

    // The month is deliberately not a directory level — a symbol holds one file
    // per month and scoping in time is a `ts` range, so the level would buy
    // nothing but an inode per symbol-month.
    expect(dirOf(key)).not.toContain('date=');

    // The name travels alone in an upload queue, where the path is not shown.
    expect(fileNameOf(key)).toBe('orderBook.okx.perp.BTCUSDT.400lv.202606.parquet');
  });

  /**
   * A log line and a path should say the same thing in the same order, but the
   * ledger key must not move — every recorded partition is found by it.
   */
  describe('the name a log uses', () => {
    const key: PartitionKey = {
      table: 'klines', venue: 'bitget', market: 'perp',
      symbol: 'BNBUSDT', month: '2019-09',
    };

    it('reads in layout order, without the letter bucket', () => {
      expect(labelOf(key)).toBe('bitget|perp|BNBUSDT|klines|2019-09');
    });

    it('keeps the ledger key stable and separate', () => {
      expect(idOf(key)).toBe('klines|bitget|perp|BNBUSDT|2019-09');
    });

    /**
     * htx publishes markPrice for one symbol-month at seven intervals. Dropping
     * the extra would give seven distinct partitions one name, in exactly the
     * log somebody is reading to tell them apart.
     */
    it('keeps an extra, so two partitions never share a name', () => {
      const a = { ...key, table: 'markPrice', interval: '1m' };
      const b = { ...key, table: 'markPrice', interval: '4h' };

      expect(labelOf(a)).not.toBe(labelOf(b));
      expect(labelOf(a)).toBe('bitget|perp|BNBUSDT|markPrice|1m|2019-09');
    });
  });

  /**
   * The letter bucket keeps a market to a few dozen entries per letter rather
   * than thousands of symbol directories, and it is the one level a query
   * engine must not see as a column.
   */
  describe('the letter a symbol is filed under', () => {
    const at = (symbol: string): string =>
      dirOf({ table: 'trades', venue: 'okx', market: 'spot', symbol, month: '2026-06' })
        .split('/').slice(-3)[0]!;

    it('files a symbol under its own initial', () => {
      expect(at('BTCUSDT')).toBe('B');
    });

    it('uppercases, so a lowercase name does not get a bucket of its own', () => {
      expect(at('allmargin')).toBe('A');
    });

    it('sends anything that is not a letter to one bucket', () => {
      expect(at('1INCHUSDT')).toBe('_');
      expect(at('10000SATSUSDT')).toBe('_');
      expect(at('龙虾-USDT')).toBe('_');
    });

    it('stays a bare segment, so nothing can filter on it', () => {
      expect(dirOf({ table: 'trades', venue: 'okx', market: 'spot',
        symbol: 'BTCUSDT', month: '2026-06' })).not.toContain('bucket=');
    });
  });
});

describe('staleness', () => {
  const key = keyOf(file());
  const record = (inputs: { path: string; size: number }[]): Built =>
    ({ id: idOf(key), key, inputs, rows: 1, builtAt: '2026-07-29T00:00:00Z' });

  it('is stale when a new input appears, or an existing one changed size', () => {
    const built = record([{ path: 'p/a.zip', size: 10 }]);

    expect(changed(built, [file(), file({ path: 'p/b.zip' })])).toBe(true);
    expect(changed(built, [file({ size: 11 })])).toBe(true);
  });

  it('is not stale when the inputs are unchanged', () => {
    expect(changed(record([{ path: 'p/a.zip', size: 10 }]), [file()])).toBe(false);
  });

  /**
   * The workflow is: back raw up to cold storage, then delete it locally. A
   * recorded input that has gone must therefore read as "already done", or
   * reclaiming disk would trigger a rebuild of everything.
   */
  it('is not stale when a recorded input has been deleted from disk', () => {
    const built = record([
      { path: 'p/a.zip', size: 10 },
      { path: 'p/b.zip', size: 20 },
    ]);

    expect(changed(built, [file()])).toBe(false);
    expect(changed(built, [])).toBe(false);
  });
});

describe('readable sizes', () => {
  it('scales to the unit that keeps the number meaningful', () => {
    expect(sizeOf(0)).toBe('0 B');
    expect(sizeOf(912)).toBe('912 B');
    expect(sizeOf(1024)).toBe('1 KB');
    expect(sizeOf(18.1 * 1024 * 1024)).toBe('18.1 MB');
    expect(sizeOf(2.4 * 1024 ** 3)).toBe('2.4 GB');
    expect(sizeOf(3 * 1024 ** 4)).toBe('3 TB');
  });

  /**
   * The case that prompted this: a thin symbol's month rounded to `0 mb` and
   * said nothing at all about what was being read.
   */
  it('never flattens a small input to zero', () => {
    expect(sizeOf(4096)).not.toMatch(/^0 /);
  });
});
