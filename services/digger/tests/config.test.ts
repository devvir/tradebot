import { describe, it, expect } from 'vitest';
import { _test_parseWaitIfQueues, _test_parseStartTime } from '../src/config';

describe('parseWaitIfQueues', () => {
  it('returns undefined for undefined input', () => {
    expect(_test_parseWaitIfQueues(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(_test_parseWaitIfQueues('')).toBeUndefined();
  });

  it('parses a single queue entry', () => {
    expect(_test_parseWaitIfQueues('myQueue:10000')).toEqual({ myQueue: 10_000 });
  });

  it('parses multiple queue entries', () => {
    const result = _test_parseWaitIfQueues('queueA:10000,queueB:5000');

    expect(result).toEqual({ queueA: 10_000, queueB: 5_000 });
  });

  it('trims whitespace around names and depths', () => {
    const result = _test_parseWaitIfQueues(' queueA : 10000 , queueB : 5000 ');

    expect(result).toEqual({ queueA: 10_000, queueB: 5_000 });
  });

  it('skips entries with non-numeric depth', () => {
    const result = _test_parseWaitIfQueues('good:1000,bad:notanumber,alsogood:2000');

    expect(result).toEqual({ good: 1_000, alsogood: 2_000 });
  });

  it('returns undefined when all entries are invalid', () => {
    expect(_test_parseWaitIfQueues('bad:notanumber')).toBeUndefined();
  });

  it('returns undefined for a missing depth separator', () => {
    expect(_test_parseWaitIfQueues('queueWithNoColon')).toBeUndefined();
  });
});

describe('parseStartTime', () => {
  it('returns undefined for undefined input', () => {
    expect(_test_parseStartTime(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(_test_parseStartTime('')).toBeUndefined();
  });

  it('parses an ISO-8601 string', () => {
    expect(_test_parseStartTime('2019-01-01T00:00:00.000Z'))
      .toBe(Date.UTC(2019, 0, 1));
  });

  it('parses an epoch ms numeric string', () => {
    expect(_test_parseStartTime('1546300800000')).toBe(1_546_300_800_000);
  });

  it('throws on a malformed value', () => {
    expect(() => _test_parseStartTime('not-a-date')).toThrow(/DIGGER_START_TIME/);
  });
});
