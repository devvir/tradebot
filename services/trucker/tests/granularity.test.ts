import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAILY_FROM, MONTHLY_THROUGH, atCutover } from '../src/venues/granularity';
import { okx, _test_resetCache } from '../src/venues/okx';
import type { ArchiveFile, Dataset, Period } from '../src/types';

const SWAP: Dataset = { id: 'swap-trades', kind: 'trades', market: 'SWAP', path: 'trades' };
const SYMBOL = 'BTC-USDT-SWAP';

/**
 * One fixed boundary in the past decides granularity everywhere: months to its
 * left, days to its right. Both sides are settled history, so no date can ever
 * be covered by two files and the answer does not depend on when trucker runs.
 */
describe('the cutover', () => {
  const file = (path: string, date: string, period: Period): ArchiveFile =>
    ({ url: `https://x/${path}`, path, date, symbol: 'BTCUSDT', period });

  it('takes the month and drops its days, where both are published', () => {
    const kept = atCutover([
      file('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip',  '202606',   'monthly'),
      file('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-06-01.zip', '20260601', 'daily'),
      file('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-06-02.zip', '20260602', 'daily'),
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.path).toContain('/monthly/');
    expect(kept[0]!.date).toBe('20260630');
  });

  it('takes days after the boundary and the month before it, with no gap between', () => {
    const kept = atCutover([
      file('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip',  '202606',   'monthly'),
      file('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-01.zip', '20260701', 'daily'),
    ]);

    expect(kept.map(f => f.date)).toEqual(['20260630', '20260701']);
  });

  it('ignores a monthly file past the boundary, so July is never taken twice', () => {
    const kept = atCutover([
      file('spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-07.zip',  '202607',   'monthly'),
      file('spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-01.zip', '20260701', 'daily'),
    ]);

    expect(kept.map(f => f.path)).toEqual([
      'spot/daily/trades/BTCUSDT/BTCUSDT-trades-2026-07-01.zip',
    ]);
  });

  /**
   * Bybit's perp trades are days back to 2020 and nothing else, as are Binance
   * `metrics` and `bookDepth`. Dropping days before the boundary on a listing
   * with no months in it would delete the entire history.
   */
  it('keeps every day when the listing holds no monthly file', () => {
    const only = [
      file('trading/BTCUSDT/BTCUSDT2020-03-25.csv.gz', '20200325', 'daily'),
      file('trading/BTCUSDT/BTCUSDT2026-07-25.csv.gz', '20260725', 'daily'),
    ];

    expect(atCutover(only)).toEqual(only);
  });

  /**
   * Binance `fundingRate` has no daily form at all, so applying the boundary
   * would drop every month after it and the series would stop at the cutover.
   */
  it('keeps every month when the listing holds no daily file', () => {
    const only = [
      file('um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2020-01.zip', '202001', 'monthly'),
      file('um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2026-07.zip', '202607', 'monthly'),
    ];

    expect(atCutover(only).map(f => f.date)).toEqual(['20200131', '20260731']);
  });

  it('puts the boundary between two settled periods, never a live one', () => {
    expect(MONTHLY_THROUGH < new Date().toISOString().slice(0, 7).replace('-', '')).toBe(true);
    expect(DAILY_FROM <= new Date().toISOString().slice(0, 10).replace(/-/g, '')).toBe(true);
  });
});

describe('okx granularity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T09:00:00Z'));

    _test_resetCache();

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok:   true,
      json: async () => ({ data: [{ instId: SYMBOL, listTime: '1633046400000' }] }),   // 2021-10-01
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('constructs months up to the boundary and days after it, never both', async () => {
    const files   = await okx.files(SWAP, SYMBOL, null);
    const monthly = files.filter(f => f.path.includes('/monthly/'));
    const daily   = files.filter(f => f.path.includes('/daily/'));

    expect(monthly.length + daily.length).toBe(files.length);
    expect(new Set(files.map(f => f.path)).size).toBe(files.length);

    expect(monthly.at(0)!.path).toContain('/monthly/202110/');    // the listing month
    expect(monthly.at(-1)!.path).toContain('/monthly/202606/');   // the boundary

    expect(daily.at(0)!.path).toContain('/daily/20260701/');
    expect(daily.at(-1)!.path).toContain('/daily/20260727/');     // today is still being written
  });

  it('covers every day across the boundary exactly once', async () => {
    const files = await okx.files(SWAP, SYMBOL, null);
    const days  = new Set<string>();

    for (const f of files) {
      const from = f.period === 'monthly' ? `${f.date.slice(0, 6)}01` : f.date;

      for (let d = new Date(iso(from)); iso2(d) <= f.date; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = iso2(d);

        expect(days.has(day)).toBe(false);   // never covered twice
        days.add(day);
      }
    }

    expect(days.has('20260630')).toBe(true);
    expect(days.has('20260701')).toBe(true);
  });

  it('keys a monthly file by its last day, so the cursor can compare it to a daily', async () => {
    const files = await okx.files(SWAP, SYMBOL, null);

    expect(files.find(f => f.path.includes('/monthly/202602/'))!.date).toBe('20260228');
    expect(files.every((f, i) => i === 0 || files[i - 1]!.date <= f.date)).toBe(true);
  });

  it('offers nothing the cursor has already settled', async () => {
    expect(await okx.files(SWAP, SYMBOL, '20260727')).toEqual([]);
  });

  /** A cursor landing on a month end must not re-offer that month as days. */
  it('resumes into days when the cursor sits on the boundary', async () => {
    const files = await okx.files(SWAP, SYMBOL, '20260630');

    expect(files.every(f => f.period === 'daily')).toBe(true);
    expect(files.at(0)!.date).toBe('20260701');
  });

  it('offers no month earlier than the symbol listed', async () => {
    const files = await okx.files(SWAP, SYMBOL, null);

    expect(files.every(f => f.date >= '20211001')).toBe(true);
  });
});

const iso  = (ymd: string): string => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const iso2 = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');
