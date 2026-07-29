import { describe, expect, it } from 'vitest';
import { grouper } from '../src/group';
import { clipFor, donatedMonths, requiredThrough } from '../src/spill';
import type { Candidate, RawFile, Series, Spill } from '../src/types';

/**
 * The trait under test: a venue whose day cuts at 16:00 UTC rather than
 * midnight (bitget), so the file named for a day holds the previous day's
 * tail. Timestamps are correct as published — only which file holds a row is
 * shifted — so the machinery is neighbour files plus a clip, never a
 * transformation.
 */

const seriesOf = (spill?: Spill): Series => ({
  source: 'trucker', venue: 'bitget', table: 'trades', market: 'spot',
  match: /(?<symbol>x)/, container: 'zip', format: 'csv', header: true,
  project: {}, ts: 'timestamp', spill,
});

const fileOf = (series: Series, symbol: string, name: string, month: string): RawFile => ({
  path:      `trades/SPBL/${symbol}/${name}`,
  absolute:  `/raw/bitget/trades/SPBL/${symbol}/${name}`,
  series, rawSymbol: symbol, month,
  size: 1,
});

describe('donatedMonths', () => {
  const back = seriesOf('back');

  it('is empty for a series that does not spill', () => {
    expect(donatedMonths(fileOf(seriesOf(), 'BTCUSDT', '20250101_001.zip', '2025-01')))
      .toEqual([]);
  });

  it('donates a first-of-month bucket to the previous month, and only that', () => {
    expect(donatedMonths(fileOf(back, 'BTCUSDT', '20250101_001.zip', '2025-01')))
      .toEqual(['2024-12']);
    expect(donatedMonths(fileOf(back, 'BTCUSDT', '20250102_001.zip', '2025-01')))
      .toEqual([]);
    expect(donatedMonths(fileOf(back, 'BTCUSDT', '20250131_001.zip', '2025-01')))
      .toEqual([]);
  });

  it('donates a last-of-month bucket forward, respecting month lengths', () => {
    const forward = seriesOf('forward');

    expect(donatedMonths(fileOf(forward, 'BTCUSDT', '20240229.zip', '2024-02')))
      .toEqual(['2024-03']);
    expect(donatedMonths(fileOf(forward, 'BTCUSDT', '20240228.zip', '2024-02')))
      .toEqual([]);
  });

  it('donates both edges for a series spilling both ways', () => {
    const both = seriesOf('both');

    expect(donatedMonths(fileOf(both, 'BTCUSDT', '20250101.zip', '2025-01')))
      .toEqual(['2024-12']);
    expect(donatedMonths(fileOf(both, 'BTCUSDT', '20250131.zip', '2025-01')))
      .toEqual(['2025-02']);
  });

  /** A monthly bucket is its month's first and last bucket at once. */
  it('treats a monthly file as both edges', () => {
    expect(donatedMonths(fileOf(back, 'BTCUSDT', 'BTCUSDT-202501.zip', '2025-01')))
      .toEqual(['2024-12']);
  });
});

describe('requiredThrough', () => {
  it('extends a back-spilling month one bucket past its end', () => {
    expect(requiredThrough(seriesOf('back'), '2025-01')).toBe('20250201');
    expect(requiredThrough(seriesOf('both'), '2024-12')).toBe('20250101');
  });

  it('leaves aligned and forward-spilling months at their own end', () => {
    expect(requiredThrough(seriesOf(), '2025-01')).toBe('20250131');
    expect(requiredThrough(seriesOf('forward'), '2025-01')).toBe('20250131');
  });
});

describe('clipFor', () => {
  it('is inert for an aligned series', () => {
    expect(clipFor(seriesOf(), '2025-01')).toBe('');
  });

  it('bounds a spilling series to exactly its month, in microseconds', () => {
    const clip = clipFor(seriesOf('back'), '2025-01');

    expect(clip).toBe(` AND ts >= ${Date.UTC(2025, 0, 1) * 1000}` +
      ` AND ts < ${Date.UTC(2025, 1, 1) * 1000}`);
  });
});

describe('grouping around a spill', () => {
  const back = seriesOf('back');
  const everything = () => true;

  const feedAll = (groups: ReturnType<typeof grouper>, files: RawFile[]) =>
    [...files.flatMap(f => groups.feed(f)), ...groups.end()];

  it('groups an aligned series exactly as before', () => {
    const plain = seriesOf();
    const done  = feedAll(grouper(everything), [
      fileOf(plain, 'A', '20250115.zip', '2025-01'),
      fileOf(plain, 'A', '20250116.zip', '2025-01'),
      fileOf(plain, 'A', '20250201.zip', '2025-02'),
      fileOf(plain, 'B', '20250115.zip', '2025-01'),
    ]);

    expect(done.map(g => [g.id, g.inputs.length])).toEqual([
      ['trades|bitget|spot|A|2025-01', 2],
      ['trades|bitget|spot|A|2025-02', 1],
      ['trades|bitget|spot|B|2025-01', 1],
    ]);
  });

  /**
   * The bitget shape: a month's tail lives in the first bucket of the next
   * month, and that bucket can be split across numbered parts — all of which
   * must reach the closing partition, not just the one that crossed the
   * boundary first.
   */
  it('hands every part of the first bucket back, then seeds the next month with them', () => {
    const dec1  = fileOf(back, 'A', '20241231_001.zip', '2024-12');
    const jan1a = fileOf(back, 'A', '20250101_001.zip', '2025-01');
    const jan1b = fileOf(back, 'A', '20250101_002.zip', '2025-01');
    const jan2  = fileOf(back, 'A', '20250102_001.zip', '2025-01');

    const done = feedAll(grouper(everything), [dec1, jan1a, jan1b, jan2]);

    expect(done.map(g => [g.id, g.inputs])).toEqual([
      ['trades|bitget|spot|A|2024-12', [dec1, jan1a, jan1b]],
      ['trades|bitget|spot|A|2025-01', [jan1a, jan1b, jan2]],
    ]);
  });

  /**
   * The month bound / running month case: the donor's own month is out of
   * scope, but the month it completes is in scope — the donation must happen
   * anyway, and no partition may form for the unwanted month.
   */
  it('takes a donation from a file whose own month is not wanted', () => {
    const dec  = fileOf(back, 'A', '20241231_001.zip', '2024-12');
    const jan1 = fileOf(back, 'A', '20250101_001.zip', '2025-01');

    const done = feedAll(grouper(f => f.month === '2024-12'), [dec, jan1]);

    expect(done.map(g => [g.id, g.inputs])).toEqual([
      ['trades|bitget|spot|A|2024-12', [dec, jan1]],
    ]);
  });

  /** A symbol whose collection ends mid-history has no donor; the month still closes. */
  it('closes a month with no donation when the walk moves to another symbol', () => {
    const decA = fileOf(back, 'A', '20241230_001.zip', '2024-12');
    const janB = fileOf(back, 'B', '20250115_001.zip', '2025-01');

    const done = feedAll(grouper(everything), [decA, janB]);

    expect(done.map(g => [g.id, g.inputs.length])).toEqual([
      ['trades|bitget|spot|A|2024-12', 1],
      ['trades|bitget|spot|B|2025-01', 1],
    ]);
  });

  it('parks a forward donation until its month arrives', () => {
    const forward = seriesOf('forward');
    const jan31   = fileOf(forward, 'A', '20250131.zip', '2025-01');
    const feb1    = fileOf(forward, 'A', '20250201.zip', '2025-02');

    const done = feedAll(grouper(everything), [jan31, feb1]);

    expect(done.map(g => [g.id, g.inputs])).toEqual([
      ['trades|bitget|spot|A|2025-01', [jan31]],
      ['trades|bitget|spot|A|2025-02', [feb1, jan31]],
    ]);
  });

  /** A walk ending on the boundary: the carried files still form their month. */
  it('flushes a carried group at the end of the walk', () => {
    const dec  = fileOf(back, 'A', '20241231_001.zip', '2024-12');
    const jan1 = fileOf(back, 'A', '20250101_001.zip', '2025-01');

    const done = feedAll(grouper(everything), [dec, jan1]);

    expect(done.map(g => [g.id, g.inputs])).toEqual([
      ['trades|bitget|spot|A|2024-12', [dec, jan1]],
      ['trades|bitget|spot|A|2025-01', [jan1]],
    ]);
  });
});

/** Filters see the donation under the month it completes, not the file's own. */
describe('wanted() and neighbours', () => {
  it('offers the neighbour month to the filter, not the file month', () => {
    const seen: string[] = [];
    const spy = (f: Candidate) => { seen.push(f.month); return true; };

    grouper(spy).feed(fileOf(seriesOf('back'), 'A', '20250101_001.zip', '2025-01'));

    expect(seen).toEqual(['2024-12', '2025-01']);
  });
});
