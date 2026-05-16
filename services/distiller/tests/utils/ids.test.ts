import { describe, it, expect } from 'vitest';
import { startOfDayId } from '../../src/utils/ids';

describe('startOfDayId', () => {
  const cases: Array<[string, number]> = [
    ['20260403',                    5271608499372032],
    ['2026-04-03',                  5271608499372032],
    ['2026-04-03T00:00:00.000Z',    5271608499372032],
    ['2026-04-03T15:30:59.999Z',    5271608499372032],
    ['20191123',                    3994525743710208],
    ['2019-11-23',                  3994525743710208],
    ['2019-11-23T00:00:00.000Z',    3994525743710208],
    ['2019-11-23T23:59:59.999Z',    3994525743710208],
  ];

  it.each(cases)('%s → %i', (input, expected) => {
    expect(startOfDayId(input)).toBe(expected);
  });
});
