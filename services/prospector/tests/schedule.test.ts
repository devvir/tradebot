import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSchedule, walkIsDue } from '../src/schedule';

/**
 * On which days of the month a venue's update is a walk: read from a file that
 * need not be there, and asked as "has one of its days come round since the
 * last walk began". See `schedule.ts`.
 */

let dir: string;

/** Venues that can be listed, each with the lowest id of its servers; okx exists and cannot be. */
const WALKABLE = new Map([['binance', 1], ['bitget', 2], ['bybit', 3], ['gate', 5]]);
const KNOWN    = ['binance', 'bitget', 'bybit', 'gate', 'okx'];

const load = (text?: string): Map<string, number[]> => {
  const path = join(dir, 'walk-schedule.yaml');

  if (text !== undefined) writeFileSync(path, text);

  return loadSchedule(path, WALKABLE, KNOWN);
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'schedule-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('the schedule file', () => {
  /** Nobody chose, so no two venues walk the same night: each takes the day that is its own number. */
  it('need not be there: every venue then walks on the day of its own id', () => {
    expect(Object.fromEntries(load())).toEqual({ binance: [1], bitget: [2], bybit: [3], gate: [5] });
  });

  it('sets the days of the venues it names, and leaves the rest on their own', () => {
    expect(Object.fromEntries(load('binance: 15\nbitget: 1,10,20\n')))
      .toEqual({ binance: [15], bitget: [1, 10, 20], bybit: [3], gate: [5] });
  });

  it('takes a venue with no days as one that never walks', () => {
    expect(load('gate:\n').get('gate')).toEqual([]);
  });

  it('reads `=` for `:`, comments, blank lines and a list in brackets', () => {
    expect(Object.fromEntries(load('# when to walk\n\nbinance=15   # mid-month\nbitget: [20, 1, 1]\ngate=\n')))
      .toEqual({ binance: [15], bitget: [1, 20], bybit: [3], gate: [] });
  });

  /** A day past the thirtieth is no day of every month, and an id past thirty wraps round to one that is. */
  it('keeps a default day within the month however many venues there are', () => {
    const many = loadSchedule(join(dir, 'none.yaml'), new Map([['a', 30], ['b', 31], ['c', 61]]), ['a', 'b', 'c']);

    expect(Object.fromEntries(many)).toEqual({ a: [30], b: [1], c: [1] });
  });

  it.each([
    ['nowhere: 3',        /'nowhere' is not a venue/],
    ['okx: 3',            /'okx' cannot be listed/],
    ['binance: 0',        /'0' is not a day of the month from 1 to 30/],
    ['binance: 31',       /'31' is not a day/],
    ['binance: monday',   /'monday' is not a day/],
    ['binance: 1.5',      /'1.5' is not a day/],
    ['binance 15',        /line 1 .* is not of the form "venue: days"/],
    ['binance: 1\nbinance: 2', /line 2 .* names 'binance' a second time/],
  ])('refuses %j', (text, why) => {
    expect(() => load(text)).toThrow(why);
  });
});

describe('whether an update is a walk', () => {
  const DAY = 86_400;
  const at  = (iso: string) => new Date(iso);

  /** How long before `now` a walk began, given when it began. */
  const since = (began: string, now: string) => (Date.parse(now) - Date.parse(began)) / 1000;

  it('is, on the scheduled day, where the last walk began before it', () => {
    expect(walkIsDue([15], since('2026-09-15T02:00:00Z', '2026-10-15T03:00:00Z'), at('2026-10-15T03:00:00Z'))).toBe(true);
  });

  it('is not, on any other day, while the last walk covered the last scheduled one', () => {
    expect(walkIsDue([15], since('2026-10-15T03:00:00Z', '2026-10-20T03:00:00Z'), at('2026-10-20T03:00:00Z'))).toBe(false);
  });

  /** The service was down on the 15th: the walk is made up at the first update after. */
  it('is, days late, where the scheduled day passed with nothing running', () => {
    expect(walkIsDue([15], since('2026-09-15T02:00:00Z', '2026-10-19T03:00:00Z'), at('2026-10-19T03:00:00Z'))).toBe(true);
  });

  it('is once for a day, not again on the next update', () => {
    expect(walkIsDue([15], since('2026-10-15T03:00:00Z', '2026-10-16T04:00:00Z'), at('2026-10-16T04:00:00Z'))).toBe(false);
  });

  /** A walk that began late on the 14th and a day beginning at midnight are one walk. */
  it('is never within a day of the last walk, whatever the dates say', () => {
    expect(walkIsDue([15], since('2026-10-14T20:00:00Z', '2026-10-15T03:00:00Z'), at('2026-10-15T03:00:00Z'))).toBe(false);
    expect(walkIsDue([15], since('2026-10-14T20:00:00Z', '2026-10-15T21:00:00Z'), at('2026-10-15T21:00:00Z'))).toBe(true);
  });

  it('takes the newest of several days', () => {
    const now = '2026-10-12T03:00:00Z';

    expect(walkIsDue([1, 10, 20], since('2026-10-02T00:00:00Z', now), at(now))).toBe(true);
    expect(walkIsDue([1, 10, 20], since('2026-10-10T05:00:00Z', now), at(now))).toBe(false);
  });

  /** February has no thirtieth: the one before it is January's, and March's comes in its turn. */
  it('looks past a month that lacks the day', () => {
    const now = '2027-03-05T03:00:00Z';

    expect(walkIsDue([30], since('2027-01-30T03:00:00Z', now), at(now))).toBe(false);
    expect(walkIsDue([30], since('2027-01-29T03:00:00Z', now), at(now))).toBe(true);
  });

  it('is for a venue that has never walked, and never for one with no days', () => {
    expect(walkIsDue([15], Infinity, at('2026-10-01T00:00:00Z'))).toBe(true);
    expect(walkIsDue([], Infinity, at('2026-10-15T00:00:00Z'))).toBe(false);
    expect(walkIsDue([], 400 * DAY, at('2026-10-15T00:00:00Z'))).toBe(false);
  });
});
