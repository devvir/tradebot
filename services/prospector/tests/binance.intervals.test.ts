import { describe, expect, it } from 'vitest';
import { binance } from '../src/adapters/binance';

/**
 * Binance's abandoned intervals.
 *
 * **Every path here was taken from the archive**, including the lone 2026 file
 * that followed three years of silence and the spot monthly keys still being
 * written on a stale schedule.
 */

const accepts = (path: string) => binance.accepts!(path);

describe('what binance refuses as an abandoned interval', () => {
  it('refuses 1w, 3d and 1mo in the futures daily trees', () => {
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/1w/BTCUSDT-1w-2023-06-12.zip')).toBe(false);
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/3d/BTCUSDT-3d-2023-12-08.zip')).toBe(false);
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/1mo/BTCUSDT-1mo-2023-05-01.zip')).toBe(false);
    expect(accepts('data/futures/cm/daily/indexPriceKlines/BTCUSD_PERP/3d/BTCUSD_PERP-3d-2023-06-15.zip'))
      .toBe(false);
  });

  /** The 334-byte file uploaded in July 2026, three years after the shape stopped. */
  it('refuses the stray that outlived the shape', () => {
    expect(accepts('data/futures/um/daily/markPriceKlines/BTCUSDT/1w/BTCUSDT-1w-2026-06-29.zip'))
      .toBe(false);
  });

  /** Spot carries them only monthly, and is months behind on every one. */
  it('refuses them in the spot monthly tree', () => {
    expect(accepts('data/spot/monthly/klines/BTCUSDT/3d/BTCUSDT-3d-2026-07.zip')).toBe(false);
    expect(accepts('data/spot/monthly/klines/BTCUSD/1w/BTCUSD-1w-2026-04.zip')).toBe(false);
    expect(accepts('data/spot/monthly/klines/ETHUSDT/1mo/ETHUSDT-1mo-2026-06.zip')).toBe(false);
  });

  it('keeps every interval the venue actually publishes', () => {
    expect(accepts('data/spot/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2026-09-25.zip')).toBe(true);
    expect(accepts('data/spot/daily/klines/BTCUSDT/1s/BTCUSDT-1s-2026-09-25.zip')).toBe(true);
    expect(accepts('data/spot/daily/klines/BTCUSDT/1d/BTCUSDT-1d-2026-09-25.zip')).toBe(true);
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-09-25.zip')).toBe(true);
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/3m/BTCUSDT-3m-2026-09-25.zip')).toBe(true);
    expect(accepts('data/futures/um/daily/klines/BTCUSDT/12h/BTCUSDT-12h-2026-09-25.zip')).toBe(true);
  });

  /** A dataset with no interval segment at all is untouched by the rule. */
  it('keeps the datasets that carry no interval', () => {
    expect(accepts('data/futures/um/daily/trades/BTCUSDT/BTCUSDT-trades-2026-09-25.zip')).toBe(true);
    expect(accepts('data/spot/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-08.zip')).toBe(true);
    expect(accepts('data3/liquidationSnapshot/BTCUSDT/BTCUSDT-liquidationSnapshot-2024-03-31.zip'))
      .toBe(true);
  });
});
