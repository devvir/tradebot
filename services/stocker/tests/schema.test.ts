import { describe, expect, it } from 'vitest';
import { SERIES, seriesFor } from '../src/schema/series';
import { _test_decimalCol, _test_integralCols, _test_microsOf, _test_projectionFor as projectionFor, selectFor } from '../src/schema/project';
import { fieldsOf } from '../src/schema/tables';
import type { Series } from '../src/types';

describe('the series map', () => {
  /**
   * **Which levels a dataset carries is a property of the dataset, not of the
   * venue.** A venue that publishes only realised funding still files it under
   * `kind=realised`, so path depth never varies inside one table — otherwise
   * every reader and writer would have to branch on which venue it was looking
   * at, and a missing level would read as a different partition.
   *
   * Enforced rather than documented, because the failure is silent: a funding
   * series added without a `kind` would collide with whatever else that venue
   * publishes for the table, which is exactly the bug this replaced.
   */
  it('gives every funding series a kind, whatever the venue publishes', () => {
    const funding = SERIES.filter(series => series.table === 'funding');

    expect(funding.length).toBeGreaterThan(0);

    for (const series of funding)
      expect(series.kind, `${series.venue} funding has no kind`).toBeTruthy();
  });

  /** An attribute lives in the file or in the path, never both. */
  it('never projects a path attribute as a column as well', () => {
    for (const series of SERIES)
      expect(Object.keys(series.project), `${series.venue} ${series.table}`)
        .not.toContain('kind');

    expect(fieldsOf('funding').map(f => f.name)).not.toContain('kind');
  });

  it('resolves a real trucker path to a series, symbol and interval', () => {
    const trades = seriesFor('binance', 'spot/monthly/trades/BTCUSDT/BTCUSDT-trades-2026-06.zip');

    expect(trades?.series.table).toBe('trades');
    expect(trades?.symbol).toBe('BTCUSDT');
    expect(trades?.interval).toBeUndefined();

    const klines = seriesFor('htx', 'spot/daily/klines/4-USDT/5m/4-USDT-klines-5m-2026-06-08.zip');

    expect(klines?.series.table).toBe('klines');
    expect(klines?.symbol).toBe('4-USDT');
    expect(klines?.interval).toBe('5m');
  });

  /**
   * Trucker deliberately collects more than stocker maps — order books above
   * all — so an unmatched path must be skipped, never guessed at.
   */
  it('returns null for a path it does not know', () => {
    expect(seriesFor('okx', 'orderbook/L2/400lv/daily/20260725/BTC-USDT-L2orderbook-400lv-2026-07-25.tar.gz'))
      .toBeNull();
    expect(seriesFor('binance', 'spot/daily/somethingNew/BTCUSDT/x.zip')).toBeNull();
  });

  /**
   * Named group present *and* usable. Checking the pattern's source text for
   * `?<symbol>` was the previous version of this, and it passes for a regex
   * that matches nothing on earth — which is how a broken entry survived.
   * Whether each pattern matches its venue's real paths is settled in
   * `mapping.test.ts`, against files from the venue.
   */
  it('captures a symbol group for every series', () => {
    for (const series of SERIES) {
      const label = `${series.venue}/${series.table}/${series.market}`;

      expect(series.match.exec('')?.groups, label).toBeUndefined();
      expect(new RegExp(series.match).source, label).toMatch(/\(\?<symbol>/);
    }
  });

  /** A headerless file has no other way to know what its columns are. */
  it('declares columns for every headerless series and none for header ones', () => {
    for (const series of SERIES) {
      if (series.header) continue;

      expect(series.columns, `${series.venue}/${series.table}/${series.market}`).toBeDefined();
      expect(series.columns!.length).toBeGreaterThan(0);
    }
  });

  /** The ts column must be one stocker can actually find in the relation. */
  it('names a ts column that the headerless column list contains', () => {
    for (const series of SERIES) {
      if (series.header || ! series.columns) continue;

      const names = series.columns.map(c => c.as).filter(Boolean);

      expect(names, `${series.venue}/${series.table}/${series.market}`).toContain(series.ts);
    }
  });
});

describe('projection into the canonical schema', () => {
  const seriesOf = (over: Partial<Series>): Series => ({
    source: 't', venue: 'v', table: 'trades', market: 'spot',
    match: /(?<symbol>x)/, container: 'zip', format: 'csv', header: true,
    project: {}, ts: 'time', ...over,
  });

  /**
   * Every series emits the table's full column list in the table's order. That
   * is what makes one table one dataset rather than a pile of venue shapes.
   */
  it('emits every canonical column, in order, whatever the venue publishes', () => {
    const sql = projectionFor(seriesOf({ project: { price: 'p' } }));

    for (const field of fieldsOf('trades'))
      expect(sql).toContain(` AS ${field.name}`);

    const order = fieldsOf('trades').map(f => sql.indexOf(` AS ${f.name}`));

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('fills a field the venue does not publish with a typed NULL', () => {
    const sql = projectionFor(seriesOf({ project: { price: 'p' } }));

    expect(sql).toContain('CAST(p AS DOUBLE) AS price');
    expect(sql).toContain('CAST(NULL AS VARCHAR) AS side');
  });
});

describe('timestamp conversion', () => {
  /**
   * The unit is read from the value, so the expression carries no unit of its
   * own — it must branch on magnitude and must not name one.
   */
  it('decides the unit from the value rather than from a declaration', () => {
    const sql = _test_microsOf();

    expect(sql).toContain('100000000000');
    expect(sql).toContain('1e14');
    expect(sql).toContain('1e17');
  });

  /**
   * An epoch in microseconds is a 16-digit integer, right at the edge of what a
   * DOUBLE holds exactly, so a DOUBLE multiply would silently round the last
   * digit of Bybit's `1784937600.0683`. Fractional values go through DECIMAL.
   */
  it('routes fractional values through DECIMAL, never DOUBLE', () => {
    expect(_test_decimalCol()).toContain('DECIMAL(38,9)');
    expect(_test_microsOf()).not.toContain('AS DOUBLE');
  });

  /**
   * DuckDB's VARCHAR→BIGINT cast **rounds** fractional text rather than
   * failing, so the integer fast path must be gated on the text being integral
   * — without the dot guard, Bybit's fractional seconds would silently lose
   * their sub-second part.
   */
  it('takes the integer path only for integral text', () => {
    expect(_test_integralCols('raw')).toContain(`strpos`);
    expect(_test_integralCols('raw')).toContain(`'.'`);
  });

  /** Text that is not a time at all must land as NULL, not as an error. */
  it('falls back to datetime parsing, then to NULL', () => {
    const sql = _test_microsOf();

    expect(sql).toContain('try_strptime');
    expect(_test_integralCols('raw')).toContain('TRY_CAST');
  });

  /**
   * The parse columns the CASE reads must actually be provided by the wrapped
   * relation `selectFor` builds — the two halves only work together.
   */
  it('wraps the relation so every parse column the CASE reads exists', () => {
    const series = {
      source: 't', venue: 'v', table: 'trades' as const, market: 'spot',
      match: /(?<symbol>x)/, container: 'zip' as const, format: 'csv' as const,
      header: true, project: {}, ts: 'time',
    };

    const sql = selectFor(series, 'read_csv([\'f\'])');

    for (const col of ['_tsText', '_tsInt', '_tsDec'])
      expect(sql).toContain(`AS ${col}`);
  });
});
