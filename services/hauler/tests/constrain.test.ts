import { describe, expect, it } from 'vitest';
import { constrain, _test_earlier, _test_later } from '../src/constrain';
import type { Config, Want } from '../src/types';

/**
 * Taking a deployment's slice of the shopping list.
 *
 * **The point of every case here is that this narrows and never widens.** A
 * want covers whatever it covers; env can only take part of that, never restate
 * it — same rule `HAULER_VENUES` already applies to `wants()`, extended to the
 * rest of a want's fields.
 */

const cfg = (over: Partial<Config> = {}): Config => ({
  archivesDir: '/data/archives', sharedDir: '/data/shared',
  catalogUrl: 'http://catalog.invalid', catalogToken: 't', port: 8080,
  venues: [], markets: [], datasets: [], concurrency: 8,
  ...over,
});

const want = (over: Partial<Want> = {}): Want =>
  ({ venue: 'gate', market: 'perp', dataset: 'klines', ...over });

describe('constrain — market and dataset', () => {
  it('passes everything through when unconstrained', () => {
    const list = [want({ market: 'perp' }), want({ market: 'spot' })];

    expect(constrain(list, cfg())).toEqual(list);
  });

  it('keeps only the configured markets', () => {
    const list = [want({ market: 'perp' }), want({ market: 'spot' })];

    expect(constrain(list, cfg({ markets: ['spot'] }))).toEqual([want({ market: 'spot' })]);
  });

  it('keeps only the configured datasets', () => {
    const list = [want({ dataset: 'klines' }), want({ dataset: 'trades' })];

    expect(constrain(list, cfg({ datasets: ['trades'] })))
      .toEqual([want({ dataset: 'trades' })]);
  });

  /**
   * **A wildcard names nothing, so there is nothing for env to narrow away.**
   *
   * Dropping it would leave a deployment that asked for `klines` fetching
   * nothing at all from a want that covers klines among everything else — and
   * looking, from the logs, as though the list were empty. The narrowing still
   * happens: `*` resolves against the catalog and the env filter applies to
   * what comes back.
   */
  it('keeps a wildcard want whatever the deployment narrows to', () => {
    const list = [want({ market: '*', dataset: '*' })];

    expect(constrain(list, cfg({ markets: ['spot'], datasets: ['trades'] }))).toEqual(list);
  });

  /** And a wildcard on one field does not excuse the other from being narrowed. */
  it('still narrows the field that is not a wildcard', () => {
    const list = [want({ market: '*', dataset: 'klines' }), want({ market: '*', dataset: 'trades' })];

    expect(constrain(list, cfg({ datasets: ['trades'] })))
      .toEqual([want({ market: '*', dataset: 'trades' })]);
  });
});

describe('constrain — span', () => {
  it('adds a bound the want did not have', () => {
    const [got] = constrain([want()], cfg({ from: '202101', to: '202312' }));

    expect(got).toMatchObject({ from: '202101', to: '202312' });
  });

  it('narrows a bound the want already had', () => {
    const [got] = constrain([want({ from: '202001', to: '202412' })],
      cfg({ from: '202101', to: '202312' }));

    expect(got).toMatchObject({ from: '202101', to: '202312' });
  });

  /** The whole point: env cannot pull a want's bound back OUT past where it was set. */
  it('never relaxes a bound the want already had past env', () => {
    const [got] = constrain([want({ from: '202101', to: '202312' })],
      cfg({ from: '201701', to: '202612' }));

    expect(got).toMatchObject({ from: '202101', to: '202312' });
  });

  it('drops a want the intersection empties out, rather than sending an inverted range', () => {
    expect(constrain([want({ from: '202301', to: '202312' })], cfg({ from: '202401' })))
      .toEqual([]);
  });

  it('leaves an unbounded want unbounded when env is too', () => {
    const [got] = constrain([want()], cfg());

    expect(got.from).toBeUndefined();
    expect(got.to).toBeUndefined();
  });
});

describe('later / earlier', () => {
  it('either side absent answers the other', () => {
    expect(_test_later(undefined, '202101')).toBe('202101');
    expect(_test_later('202101', undefined)).toBe('202101');
    expect(_test_earlier(undefined, '202312')).toBe('202312');
    expect(_test_earlier('202312', undefined)).toBe('202312');
  });

  it('both absent answers absent', () => {
    expect(_test_later(undefined, undefined)).toBeUndefined();
    expect(_test_earlier(undefined, undefined)).toBeUndefined();
  });

  it('picks the later or earlier of two', () => {
    expect(_test_later('202001', '202101')).toBe('202101');
    expect(_test_earlier('202001', '202101')).toBe('202001');
  });
});
