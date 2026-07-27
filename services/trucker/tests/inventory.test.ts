import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveFile, Period } from '../src/types';

let dir: string;

vi.mock('../src/config', () => ({
  default: { get dataDir() { return dir; }, get sharedDir() { return join(dir, 'shared'); } },
}));

const {
  askedAt, cached, changes, enumerated, filesIn, flag, load, merge, publishedThrough, record,
  shapesOf,
  _test_formatRuns: formatRuns, _test_parseRuns: parseRuns,
} = await import('../src/inventory');

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'inventory-')); });

const NOW = '2026-08-05T00:00:00.000Z';

/**
 * A binance-shaped daily key, dated `2026-07-01` in both URL and path. No
 * checksum companion: whether those exist is a venue-level fact asked for at
 * read time, which its own test below covers.
 */
const daily = (date: string, symbol = 'BTCUSDT'): ArchiveFile => ({
  url:    `https://h/data/spot/daily/trades/${symbol}/${symbol}-trades-${dashed(date)}.zip`,
  path:   `spot/daily/trades/${symbol}/${symbol}-trades-${dashed(date)}.zip`,
  date,
  symbol,
  period: 'daily',
});

/** A monthly key, whose file date is the last day of the month it covers. */
const monthly = (month: string, symbol = 'BTCUSDT'): ArchiveFile => ({
  url:    `https://h/data/spot/monthly/trades/${symbol}/${symbol}-trades-${month.slice(0, 4)}-${month.slice(4, 6)}.zip`,
  path:   `spot/monthly/trades/${symbol}/${symbol}-trades-${month.slice(0, 4)}-${month.slice(4, 6)}.zip`,
  date:   endOfMonth(month),
  symbol,
  period: 'monthly',
});

const dashed = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

const endOfMonth = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)), 0))
    .toISOString().slice(0, 10).replace(/-/g, '');

const asMap = (files: ArchiveFile[]) => {
  const shapes = shapesOf(files, NOW);
  const known  = new Map(shapes.map(s => [`${s.symbol}\t${s.period}\t${s.url}`, s]));

  return known;
};

describe('shapesOf', () => {
  /**
   * The whole ledger rests on this: a listing must survive being reduced to a
   * template and rebuilt. Anything less and the walk downloads URLs the venue
   * never published, which arrive as 404s and are read as "absent".
   */
  it('rebuilds every file it was given, byte for byte', () => {
    const files = ['20260701', '20260702', '20260703'].map(d => daily(d));
    const back  = filesIn(asMap(files), 'BTCUSDT', null, '20261231');

    expect(back).toEqual(files);
  });

  it('collapses a contiguous history to a single run', () => {
    const files  = ['20260701', '20260702', '20260703'].map(d => daily(d));
    const shapes = shapesOf(files, NOW);

    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.runs).toEqual([['20260701', '20260703']]);
    expect(shapes[0]!.style).toBe('y-m-d');
  });

  /** Bitget's early history has real holes; a run per island keeps them. */
  it('keeps a gap as two runs rather than papering over it', () => {
    const shapes = shapesOf(['20260701', '20260702', '20260705'].map(d => daily(d)), NOW);

    expect(shapes[0]!.runs).toEqual([['20260701', '20260702'], ['20260705', '20260705']]);

    const dates = filesIn(asMap(['20260701', '20260702', '20260705'].map(d => daily(d))),
      'BTCUSDT', null, '20261231').map(f => f.date);

    expect(dates).toEqual(['20260701', '20260702', '20260705']);
  });

  /**
   * Bitget publishes one series under two filename shapes in the same week, so
   * a symbol is not one template — it is however many the venue happens to use.
   */
  it('holds several shapes for one symbol', () => {
    const odd: ArchiveFile = {
      url:    'https://h/kline/BTCUSDT/BTCUSDT_SP_1min_20200803.zip',
      path:   'kline/BTCUSDT/BTCUSDT_SP_1min_20200803.zip',
      date:   '20200803', symbol: 'BTCUSDT', period: 'daily',
    };
    const usual: ArchiveFile = {
      url:    'https://h/kline/BTCUSDT/SP/20200804.zip',
      path:   'kline/BTCUSDT/SP/20200804.zip',
      date:   '20200804', symbol: 'BTCUSDT', period: 'daily',
    };

    const back = filesIn(asMap([odd, usual]), 'BTCUSDT', null, '20261231');

    expect(shapesOf([odd, usual], NOW)).toHaveLength(2);
    expect(back).toEqual([odd, usual]);
  });

  /** A monthly file is keyed by its month but reported by its last day. */
  it('renders monthly keys and reports them at the month end', () => {
    const files = [monthly('201708'), monthly('201709')];
    const back  = filesIn(asMap(files), 'BTCUSDT', null, '20261231');

    expect(back).toEqual(files);
    expect(back.map(f => f.date)).toEqual(['20170831', '20170930']);
  });

  /**
   * Whether `.CHECKSUM` companions exist is a property of the venue — only
   * binance and kucoin publish them — so it is asked for at read time rather
   * than stored against every date.
   */
  it('carries the checksum companion only where the venue publishes one', () => {
    const known = asMap([daily('20260701')]);

    const [withSum]    = filesIn(known, 'BTCUSDT', null, '20261231', true);
    const [withoutSum] = filesIn(known, 'BTCUSDT', null, '20261231');

    expect(withSum!.checksumUrl).toBe(`${withSum!.url}.CHECKSUM`);
    expect(withoutSum!.checksumUrl).toBeUndefined();
  });

  /**
   * A key that cannot be reduced is kept whole rather than dropped or guessed
   * at — the ledger never invents a URL it has not seen.
   */
  it('keeps an unreducible key verbatim', () => {
    const odd: ArchiveFile = {
      url: 'https://h/weird/latest.zip', path: 'weird/latest.zip',
      date: '20260701', symbol: 'BTCUSDT', period: 'daily',
    };

    const shapes = shapesOf([odd], NOW);

    expect(shapes[0]!.style).toBeNull();
    expect(filesIn(asMap([odd]), 'BTCUSDT', null, '20261231')).toEqual([odd]);
  });
});

describe('filesIn', () => {
  const history = () => asMap(['20260701', '20260702', '20260703', '20260801'].map(d => daily(d)));

  it('offers only what falls inside the walked window', () => {
    const dates = filesIn(history(), 'BTCUSDT', null, '20260731').map(f => f.date);

    expect(dates).toEqual(['20260701', '20260702', '20260703']);
  });

  /** `from` is the cursor, exclusive, so a settled date is never offered twice. */
  it('excludes everything up to and including the cursor', () => {
    const dates = filesIn(history(), 'BTCUSDT', '20260702', '20260831').map(f => f.date);

    expect(dates).toEqual(['20260703', '20260801']);
  });

  it('answers nothing for a symbol it has never seen', () => {
    expect(filesIn(history(), 'ETHUSDT', null, '20261231')).toEqual([]);
    expect(enumerated(history(), 'ETHUSDT')).toBe(false);
    expect(enumerated(history(), 'BTCUSDT')).toBe(true);
  });

  it('reports how far the venue publishes and when it was asked', () => {
    expect(publishedThrough(history(), 'BTCUSDT')).toBe('20260801');
    expect(askedAt(history(), 'BTCUSDT')).toBe(NOW);
    expect(publishedThrough(history(), 'ETHUSDT')).toBeNull();
  });
});

describe('merge', () => {
  /**
   * A tip refresh asks about recent dates only. Without carrying the older runs
   * forward the ledger would shrink to the window just asked about, and the
   * walk would conclude a decade of files never existed.
   */
  it('keeps history a refresh did not ask about', () => {
    const known = asMap(['20260701', '20260702'].map(d => daily(d)));
    const fresh = shapesOf([daily('20260703')], NOW);
    const after = new Map(merge(fresh, known).map(s => [`${s.symbol}\t${s.period}\t${s.url}`, s]));

    expect(filesIn(after, 'BTCUSDT', null, '20261231').map(f => f.date))
      .toEqual(['20260701', '20260702', '20260703']);
  });

  it('coalesces a refresh that abuts what was already known', () => {
    const known  = asMap(['20260701', '20260702'].map(d => daily(d)));
    const merged = merge(shapesOf([daily('20260703')], NOW), known);

    expect(merged[0]!.runs).toEqual([['20260701', '20260703']]);
  });

  it('leaves a shape it has never seen alone', () => {
    const fresh = shapesOf([daily('20260703')], NOW);

    expect(merge(fresh, new Map())).toEqual(fresh);
  });
});

describe('the ledger on disk', () => {
  it('round-trips through the file', async () => {
    const files  = [...['20260701', '20260702'].map(d => daily(d)), monthly('201708')];
    const shapes = shapesOf(files, NOW);

    await record('binance', 'spot-trades', shapes, new Map());

    const known = await load('binance', 'spot-trades');

    expect(filesIn(known, 'BTCUSDT', null, '20261231')).toEqual(
      files.sort((a, b) => (a.date < b.date ? -1 : 1)));
  });

  it('supersedes an earlier line for the same shape', async () => {
    const known = new Map();

    await record('binance', 'spot-trades', shapesOf([daily('20260701')], NOW), known);
    await record('binance', 'spot-trades',
      shapesOf(['20260701', '20260702'].map(d => daily(d)), NOW), known);

    const reloaded = await load('binance', 'spot-trades');

    expect([...reloaded.values()]).toHaveLength(1);
    expect(filesIn(reloaded, 'BTCUSDT', null, '20261231')).toHaveLength(2);
  });

  it('reads an absent ledger as empty rather than failing', async () => {
    await expect(load('nobody', 'nothing')).resolves.toEqual(new Map());
    await expect(cached('nobody', 'nothing')).resolves.toEqual(new Map());
  });

  it('writes nothing when there is nothing to record', async () => {
    await expect(record('binance', 'empty', [], new Map())).resolves.toBeUndefined();
    await expect(load('binance', 'empty')).resolves.toEqual(new Map());
  });
});

describe('runs', () => {
  it('formats a single date without a range', () => {
    expect(formatRuns([['20260701', '20260701'], ['20260801', '20260803']]))
      .toBe('20260701,20260801-20260803');
  });

  it('parses what it formats', () => {
    const runs: [string, string][] = [['20260701', '20260701'], ['20260801', '20260803']];

    expect(parseRuns(formatRuns(runs))).toEqual(runs);
  });

  it('reads an empty run list as none', () => {
    expect(parseRuns('')).toEqual([]);
  });
});

describe('changes', () => {
  const shapes = (dates: string[]) => shapesOf(dates.map(d => daily(d)), NOW);
  const held   = (dates: string[]) => asMap(dates.map(d => daily(d)));

  /**
   * The common case, and it must stay silent: a venue publishing today's file
   * is not a venue rewriting history.
   */
  it('says nothing about new files at the tip', () => {
    expect(changes(shapes(['20260701', '20260702', '20260703']), held(['20260701', '20260702'])))
      .toEqual([]);
  });

  it('says nothing when a refresh repeats what was already known', () => {
    expect(changes(shapes(['20260701', '20260702']), held(['20260701', '20260702']))).toEqual([]);
  });

  /** HTX prunes its trailing edge; everywhere else this is a genuine retraction. */
  it('reports dates the venue has withdrawn', () => {
    expect(changes(shapes(['20260703']), held(['20260701', '20260702', '20260703'])))
      .toEqual([{ symbol: 'BTCUSDT', kind: 'removed', from: '20260701', to: '20260702' }]);
  });

  /** History appearing below where the shape used to start. */
  it('reports a backfill below what was known', () => {
    expect(changes(shapes(['20260628', '20260629', '20260701']), held(['20260701'])))
      .toEqual([{ symbol: 'BTCUSDT', kind: 'backfilled', from: '20260628', to: '20260629' }]);
  });

  /** A hole that quietly fills after a month was published as complete. */
  it('reports a gap filling in', () => {
    expect(changes(shapes(['20260701', '20260702', '20260703']), held(['20260701', '20260703'])))
      .toEqual([{ symbol: 'BTCUSDT', kind: 'infilled', from: '20260702', to: '20260702' }]);
  });

  /**
   * Bitget serves one series under two names. A second name appearing over
   * dates already collected under the first would double the archive silently.
   */
  it('reports a new filename shape covering collected history', () => {
    const other: ArchiveFile = {
      url: 'https://h/data/spot/daily/trades/BTCUSDT/renamed-2026-07-01.zip',
      path: 'spot/daily/trades/BTCUSDT/renamed-2026-07-01.zip',
      date: '20260701', symbol: 'BTCUSDT', period: 'daily',
    };

    expect(changes(shapesOf([other], NOW), held(['20260701', '20260702'])))
      .toEqual([{ symbol: 'BTCUSDT', kind: 'reshaped', from: '20260701', to: '20260701' }]);
  });

  /** A first enumeration has nothing to contradict. */
  it('says nothing about a symbol it has never seen', () => {
    expect(changes(shapes(['20260701']), new Map())).toEqual([]);
  });

  /**
   * A refresh that asked about last week says nothing about 2019, so its
   * silence there must not read as a withdrawal.
   */
  it('judges only the span the venue was asked about', () => {
    expect(changes(shapes(['20260801']), held(['20190101', '20190102', '20260801']), '20260731'))
      .toEqual([]);
  });

  it('writes what it found where a human will find it', async () => {
    const found = changes(shapes(['20260703']), held(['20260701', '20260702', '20260703']));

    await flag('binance', 'spot-trades', found);

    const written = await readFile(join(dir, 'shared', 'changes', 'binance.tsv'), 'utf8');

    expect(written).toContain('spot-trades\tBTCUSDT\tremoved\t20260701\t20260702');
  });

  it('writes nothing when there is nothing to report', async () => {
    await expect(flag('binance', 'spot-trades', [])).resolves.toBeUndefined();
  });
});
