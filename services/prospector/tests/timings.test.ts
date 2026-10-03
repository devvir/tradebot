import { describe, expect, it } from 'vitest';
import { timed, timingsOf } from '../src/timings';

/** Where a venue's requests spend their time, as each heartbeat reports it. See `timings.ts`. */
describe('timings', () => {
  it('reports each stretch as an average and a 90th percentile, in order', () => {
    for (let ms = 1; ms <= 10; ms++) timed('v', 'body', ms * 10);
    timed('v', 'slot', 5);

    expect(timingsOf('v')).toEqual({
      slot: { avg: 5, p90: 5, n: 1 },
      body: { avg: 55, p90: 100, n: 10 },
    });
  });

  /** A heartbeat says how things are now, not since the process started. */
  it('starts afresh after each report', () => {
    timed('v', 'parse', 3);
    timingsOf('v');

    expect(timingsOf('v')).toEqual({});
  });

  it('keeps venues apart', () => {
    timed('a', 'process', 1);
    timed('b', 'process', 9);

    expect(timingsOf('a')).toEqual({ process: { avg: 1, p90: 1, n: 1 } });
    expect(timingsOf('b')).toEqual({ process: { avg: 9, p90: 9, n: 1 } });
  });
});
