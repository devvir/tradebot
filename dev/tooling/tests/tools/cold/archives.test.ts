import { describe, expect, it } from 'vitest';
import { CAPS, GB } from '../../../src/tools/cold/config';
import {
  archives,
  _test_datedDirectory as datedDirectory,
  _test_monthOf as monthOf,
  _test_readClosings as readClosings,
  _test_readTips as readTips,
} from '../../../src/tools/cold/planners/archives';
import { close, open } from '../../../src/tools/cold/db';
import { FactManager } from '@tradebot/pipeline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FactInput } from '@tradebot/pipeline';
import type { SourceFile } from '../../../src/tools/cold/types';

const CAP = CAPS.archives * GB;

const file = (over: Partial<SourceFile> = {}): SourceFile => ({
  path: 'bybit/trading/BTCUSDT/BTCUSDT2020-03-01.csv.gz',
  bytes: 1_000, mtime: 1,
  venue: 'bybit', month: '202003',
  market: null, symbol: null, dataset: null, variant: null,
  ...over,
});

describe('reading a month off an archive path', () => {
  it('reads the shapes the venues actually use', () => {
    expect(monthOf('bybit/trading/BTCUSDT/BTCUSDT2020-03-01.csv.gz')).toBe('202003');
    expect(monthOf('htx/futures/daily/mark-klines/BTC/2026-06.csv')).toBe('202606');
    expect(monthOf('okx/trades/monthly/202502/BTC-USDT.zip')).toBe('202502');
    expect(monthOf('gate/spot/deals/20180715/BTC_USDT.csv')).toBe('201807');
  });

  /**
   * bitget puts the date inside the filename after an underscore, so a rule
   * anchored on `/` missed 16,362 files across 15 whole venue-months — they read
   * as undated and were never packed.
   */
  it('finds a date inside a filename, not only after a path separator', () => {
    expect(monthOf('bitget/trades/SPBL/XRPUSDT/XRPUSDT_SPBL_20190506_001.zip')).toBe('201905');
    expect(monthOf('bitget/kline/ETHUSDT/ETHUSDT_SP_1min_20180725.zip')).toBe('201807');
    expect(monthOf('bitget/kline/BTCUSD/BTCUSD_UMCBL_1min_20190601.zip')).toBe('201906');
  });

  /**
   * Bybit lists symbols like `10000000AIDOGEUSDT`. A single regex matches at the
   * earliest position rather than by preference, so those eight digits would win
   * on position over the real date further along the path.
   */
  it('is not fooled by an all-numeric symbol standing in front of the date', () => {
    expect(monthOf('bybit/trading/10000000AIDOGEUSDT/10000000AIDOGEUSDT2024-05-02.csv.gz'))
      .toBe('202405');
  });

  it('refuses a path that carries no date rather than guessing one', () => {
    expect(monthOf('bybit/trading/BTCUSDT/README.md')).toBeNull();
    expect(monthOf('kucoin/spot/SYMBOLS.txt')).toBeNull();
  });

  /** A longer run of digits is a serial number, not a date. */
  it('does not read a date out of a longer digit run', () => {
    expect(monthOf('venue/data/2026070412345678.bin')).toBeNull();
  });

  it('recognises a directory named for a period, and only that', () => {
    expect(datedDirectory('202607')).toBe('202607');
    expect(datedDirectory('20260701')).toBe('202607');
    expect(datedDirectory('BTCUSDT')).toBeNull();
    expect(datedDirectory('2026')).toBeNull();
  });
});

describe('packing an archive month into tars', () => {
  it('fills to the cap in path order', () => {
    const parts = archives.pack([
      file({ path: 'c', bytes: CAP * 0.6 }),
      file({ path: 'a', bytes: CAP * 0.6 }),
      file({ path: 'b', bytes: CAP * 0.3 }),
    ], CAP);

    expect(parts.map(part => part.map(f => f.path))).toEqual([['a', 'b'], ['c']]);
  });

  /**
   * Nothing is held together here. The vault keeps a symbol whole because a
   * restore asks for one; an archive restore asks for a venue-month, and the
   * seven tree shapes offer no level that reliably names a symbol.
   */
  it('splits freely, unlike the vault', () => {
    const parts = archives.pack([
      file({ path: 'sym/a', bytes: CAP * 0.7 }),
      file({ path: 'sym/b', bytes: CAP * 0.7 }),
    ], CAP);

    expect(parts).toHaveLength(2);
  });

  it('gives an oversized file a part of its own rather than splitting it', () => {
    const parts = archives.pack([
      file({ path: 'a', bytes: CAP * 3 }),
      file({ path: 'b', bytes: 10 }),
    ], CAP);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(1);
  });

  /** A resumed plan means nothing unless a re-run produces the same parts. */
  it('packs deterministically whatever order it is handed', () => {
    const files = Array.from({ length: 30 }, (_, n) =>
      file({ path: `p${String(n).padStart(2, '0')}`, bytes: CAP / 7 }));

    expect(archives.pack(files, CAP).map(part => part.map(f => f.path)))
      .toEqual(archives.pack([...files].reverse(), CAP).map(part => part.map(f => f.path)));
  });
});

/**
 * The property that matters most here, because its absence is invisible: an
 * unmatched file is simply never packed, and the run reports success.
 */
describe('a path whose date cannot be read', () => {
  const withArchive = async (files: string[], run: (config: never) => Promise<unknown>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-arch-'));

    const trucker = new FactManager({ owner: 'trucker', root: path.join(root, 'shared', 'facts') });

    trucker.record({ topic: 'archives', venue: 'acme', period: '202601',
      fact: 'complete', value: '2026-02-01T00:00:00Z' });
    trucker.close();

    for (const relative of files) {
      fs.mkdirSync(path.join(root, 'raw', path.dirname(relative)), { recursive: true });
      fs.writeFileSync(path.join(root, 'raw', relative), 'x');
    }

    const db = open(path.join(root, 'cold.sqlite'));

    try {
      return await run({
        sourceRoot: path.join(root, 'raw'),
        sharedRoot: path.join(root, 'shared'),
        coldRoot:   root,
        megaRoot:   '/mega',
        dbPath:     path.join(root, 'cold.sqlite'),
        capBytes:   CAP,
        queueTargetGb: 10,
        handle: db,
      } as never);
    } finally {
      close(db);
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it('stops the run instead of skipping the file', async () => {
    await expect(withArchive(
      ['acme/trades/BTC/BTC_20260115.csv', 'acme/trades/BTC/README.md'],
      (config: never) => {
        const { handle, ...rest } = config as unknown as { handle: never };

        return archives.pending(handle, rest as never, []);
      },
    )).rejects.toThrow(/carry no date/);
  });

  it('names the offending paths, not just how many', async () => {
    await expect(withArchive(
      ['acme/trades/BTC/BTC_20260115.csv', 'acme/trades/BTC/NOTES.txt'],
      (config: never) => {
        const { handle, ...rest } = config as unknown as { handle: never };

        return archives.pending(handle, rest as never, []);
      },
    )).rejects.toThrow(/NOTES\.txt/);
  });

  /**
   * The filter has to reach the walk. Applying it to the result means the venue
   * was already scanned — millions of entries for a run that cannot touch it —
   * and already reported on.
   */
  it('does not walk a venue the run did not ask for', async () => {
    const plan = await withArchive(
      ['acme/trades/BTC/BTC_20260115.csv', 'acme/trades/BTC/README.md'],
      (config: never) => {
        const { handle, ...rest } = config as unknown as { handle: never };

        return archives.pending(handle, rest as never, ['somebody-else']);
      },
    ) as { groups: unknown[] };

    // The undated `README.md` would have stopped the run had acme been walked.
    expect(plan.groups).toEqual([]);
  });

  it('is satisfied when every path carries a date', async () => {
    const groups = await withArchive(
      ['acme/trades/BTC/BTC_20260115.csv', 'acme/kline/ETH/ETH_1min_20260120.zip'],
      (config: never) => {
        const { handle, ...rest } = config as unknown as { handle: never };

        return archives.pending(handle, rest as never, []);
      },
    ) as { groups: { month: string; files: unknown[] }[]; withheld: number };

    expect(groups.withheld).toBe(0);
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]!.month).toBe('202601');
    expect(groups.groups[0]!.files).toHaveLength(2);
  });
});

describe('reading what the collector has closed', () => {
  const withClosings = <T>(closed: FactInput[], run: (facts: FactManager) => T): T => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-archives-'));

    if (closed.length > 0) new FactManager({ owner: 'trucker', root }).recordAll(closed);

    const facts = new FactManager({ owner: 'tooling', root });

    try {
      return run(facts);
    } finally {
      facts.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const closed = (venue: string, period: string, at: string): FactInput =>
    ({ topic: 'archives', venue, period, fact: 'complete', value: at });

  it('takes the unbroken run, whatever order the months were closed in', () => {
    const tips = withClosings([
      closed('bybit', '202402', '2026-02-02T00:00:00Z'),
      closed('bybit', '202401', '2026-01-02T00:00:00Z'),
      closed('bybit', '202403', '2026-03-02T00:00:00Z'),
    ], facts => readTips(facts));

    expect(tips.get('bybit')).toBe('202403');
  });

  /**
   * A month left open by a failed pass is stepped over by the months that close
   * after it, and the highest of them then vouches for a hole beneath it. bybit
   * read 202501 over open 202402 and 202405.
   */
  it('stops at a hole rather than reporting the highest month closed', () => {
    const tips = withClosings([
      closed('bybit', '202401', '2026-01-02T00:00:00Z'),
      closed('bybit', '202403', '2026-03-02T00:00:00Z'),
      closed('bybit', '202404', '2026-04-02T00:00:00Z'),
    ], facts => readTips(facts));

    expect(tips.get('bybit')).toBe('202401');
  });

  it('skips a venue that has closed nothing', () => {
    expect(withClosings([], facts => readTips(facts)).size).toBe(0);
  });

  /**
   * A month reopens for real reasons — a symbol universe missing its delisted
   * names, a dataset never collected. The later closing is the one that counts,
   * and comparing it is what brings the month back into view.
   */
  it('keeps the last time a month was closed', () => {
    const closings = withClosings([
      closed('okx', '202305', '2026-01-01T00:00:00Z'),
      closed('okx', '202305', '2026-08-01T00:00:00Z'),
    ], facts => readClosings(facts));

    expect(closings.get('okx/202305')).toBe('2026-08-01T00:00:00Z');
  });
});
