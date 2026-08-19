import { describe, expect, it } from 'vitest';
import { fault, faultLine } from '../src/faults';

/**
 * What a failure is allowed to cost the log.
 *
 * Nearly every failure here is a socket that would not open, and the frames
 * leading to one are always the same — so the code is kept and the trace is not.
 * The trace survives only where nothing else can say anything.
 */

/** What `fetch` really throws when a connect times out, rebuilt exactly. */
const connectFailed = (code: string, addresses: number): Error => {
  const tried = Array.from({ length: addresses },
    () => Object.assign(new Error('connect failed'), { code }));

  return Object.assign(new TypeError('fetch failed'),
    { cause: new AggregateError(tried, code) });
};

describe('describing a failure', () => {
  it('keeps the code and drops the trace', () => {
    const seen = fault(connectFailed('ETIMEDOUT', 8));

    expect(seen).toEqual({ error: 'fetch failed', cause: 'ETIMEDOUT', tried: 8 });
    expect(seen.stack).toBeUndefined();
  });

  /**
   * **Eight addresses timing out is a different problem from one**, and neither
   * is visible in the message — so the count is kept where there was more than
   * one and left out where there was not.
   */
  it('collapses one code per address into one, and counts them', () => {
    expect(fault(connectFailed('ECONNREFUSED', 1)))
      .toEqual({ error: 'fetch failed', cause: 'ECONNREFUSED' });
  });

  it('keeps every distinct code when the addresses disagreed', () => {
    const mixed = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([
        Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('y'), { code: 'ECONNREFUSED' }),
      ]),
    });

    expect(fault(mixed)).toMatchObject({ cause: 'ETIMEDOUT,ECONNREFUSED', tried: 2 });
  });

  it('reads a single cause that is not an aggregate', () => {
    const reset = Object.assign(new TypeError('fetch failed'),
      { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

    expect(fault(reset)).toEqual({ error: 'fetch failed', cause: 'ECONNRESET' });
  });

  /**
   * **The case a trace is actually for.** Nothing here recognises it, so the
   * frames nearest the throw are the only thing left — trimmed, because the rest
   * is the same path every time.
   */
  it('keeps a trimmed trace for a failure it cannot name', () => {
    const odd  = new RangeError('index out of range');
    const seen = fault(odd);

    expect(seen.error).toBe('index out of range');
    expect(seen.cause).toBeUndefined();
    expect(seen.stack).toContain('at ');
    expect(seen.stack!.split(' < ').length).toBeLessThanOrEqual(3);
  });

  it('says something useful about a thrown non-error', () => {
    expect(fault('nope')).toEqual({ error: 'nope' });
  });

  it('renders as one line where a log has no room for an object', () => {
    expect(faultLine(connectFailed('ETIMEDOUT', 8))).toBe('fetch failed — ETIMEDOUT — x8');
    expect(faultLine(new RangeError('bad'))).toBe('bad');
  });
});
