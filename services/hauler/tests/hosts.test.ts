import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which address a file is asked of, where a server answers at several: by how
 * each has been doing, never by how often it was asked. See `hosts.ts`.
 */

vi.mock('../src/config', () => ({ default: {} }));

const { setHosts, hostFor, mainOf, delivered, faltered, refused, backAt, _test_reweigh, _test_hostsOf, _test_forget } =
  await import('../src/hosts');

const BUCKET = 'https://bucket.example/';
const CDN    = 'https://cdn.example/';

const hosts  = () => _test_hostsOf('gate', '');
const shares = () => Object.fromEntries(hosts().map(host => [host.base, Number(host.weight.toFixed(2))]));
const look   = () => _test_reweigh('gate', '');

/** A minute in which an address delivered this many files of a megabyte, each in so long. */
const minute = (base: string, files: number, msEach: number, failed = 0): void => {
  const host = hosts().find(one => one.base === base)!;

  for (let at = 0; at < files; at++) delivered(host, 1024 ** 2, msEach);
  for (let at = 0; at < failed; at++) faltered(host);
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
  _test_forget();
  setHosts('gate', { '': [BUCKET, CDN] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the addresses of a server', () => {
  it('start with an even share, the listed one known for it', () => {
    expect(shares()).toEqual({ [BUCKET]: 0.5, [CDN]: 0.5 });
    expect(mainOf('gate', '')!.base).toBe(BUCKET);
  });

  /** Bytes a second while delivering: an address asked a tenth as often is not marked down for it. */
  it('are weighed by what they deliver while delivering, not by how much they were asked', () => {
    minute(BUCKET, 400, 1000);
    minute(CDN, 40, 1000);
    look();

    expect(shares()).toEqual({ [BUCKET]: 0.5, [CDN]: 0.5 });
  });

  it('give the faster one more of the work', () => {
    minute(BUCKET, 100, 1000);
    minute(CDN, 100, 250);
    look();

    // Half way from even at the first look, and on toward four to one after.
    expect(shares()).toEqual({ [BUCKET]: 0.35, [CDN]: 0.65 });

    for (let at = 0; at < 6; at++) { minute(BUCKET, 100, 1000); minute(CDN, 100, 250); look(); }

    expect(shares()).toEqual({ [BUCKET]: 0.2, [CDN]: 0.8 });
  });

  /** One look blends half of what the minute measured into what was known. */
  it('move half way at a look, so one bad minute does not turn the choice round', () => {
    minute(BUCKET, 100, 1000);
    minute(CDN, 100, 1000);
    look();
    minute(BUCKET, 100, 1000);
    minute(CDN, 100, 4000);
    look();

    expect(shares()[CDN]).toBeCloseTo(0.38, 2);
  });

  it('are not judged on a handful of requests', () => {
    minute(CDN, 5, 10_000);
    look();

    expect(shares()).toEqual({ [BUCKET]: 0.5, [CDN]: 0.5 });
  });

  it('lose share for the requests that failed', () => {
    minute(BUCKET, 100, 1000);
    minute(CDN, 50, 1000, 50);
    look();

    expect(shares()[CDN]).toBeCloseTo(0.42, 2);
  });
});

describe('an address that turns us away', () => {
  it('is out at once on a 429, for three minutes, and the other carries everything', () => {
    const cdn = hosts()[1]!;

    refused(cdn, 429, null);

    expect(backAt(cdn) - Date.now()).toBe(180_000);

    for (let at = 0; at < 50; at++) expect(hostFor('gate', '')!.base).toBe(BUCKET);
  });

  it('is out for as long as it says, where it says', () => {
    const cdn = hosts()[1]!;

    refused(cdn, 503, 45_000);

    expect(backAt(cdn) - Date.now()).toBe(45_000);
  });

  /** One 403 can be a file an edge will not serve; five running, nothing delivered between, is a block. */
  it('is out on the fifth 403 running, and not before', () => {
    const cdn = hosts()[1]!;

    for (let at = 0; at < 4; at++) refused(cdn, 403, null);

    expect(backAt(cdn)).toBe(0);

    delivered(cdn, 10, 10);

    for (let at = 0; at < 4; at++) refused(cdn, 403, null);

    expect(backAt(cdn)).toBe(0);

    refused(cdn, 403, null);

    expect(backAt(cdn) - Date.now()).toBe(180_000);
  });

  it('is left alone twice as long when it does it again', () => {
    const cdn = hosts()[1]!;

    refused(cdn, 429, null);
    vi.advanceTimersByTime(180_000);
    refused(cdn, 429, null);

    expect(backAt(cdn) - Date.now()).toBe(360_000);
  });

  it('comes back on trial, at a tenth of the work', () => {
    const cdn = hosts()[1]!;

    minute(BUCKET, 100, 100);
    refused(cdn, 429, null);
    vi.advanceTimersByTime(181_000);
    look();

    expect(shares()[CDN]).toBeCloseTo(0.1, 1);
    expect(hostFor('gate', '', new Set([hosts()[0]!]))!.base).toBe(CDN);
  });

  it('leaves nothing to ask where it is the only one, until it is back', () => {
    setHosts('okx', { '': ['https://only.example/'] });

    const only = mainOf('okx', '')!;

    refused(only, 429, null);

    expect(hostFor('okx', '')).toBeNull();

    vi.advanceTimersByTime(180_000);

    expect(hostFor('okx', '')).toBe(only);
  });
});

describe('an address doing far worse than the rest', () => {
  const slow = () => { minute(BUCKET, 100, 100); minute(CDN, 100, 100_000); look(); };

  it('keeps a floor of one chance in a hundred, so it is never out for good', () => {
    for (let at = 0; at < 6; at++) slow();

    expect(shares()[CDN]).toBeCloseTo(0.01, 2);
  });

  /** After half an hour at the floor: a tenth of the work for five minutes, its old score forgotten. */
  it('is given a trial after half an hour at the floor', () => {
    for (let at = 0; at < 6; at++) slow();

    vi.advanceTimersByTime(30 * 60_000);
    slow();

    expect(shares()[CDN]).toBeCloseTo(0.1, 2);

    // It proves itself during the trial, and keeps what it earned.
    minute(BUCKET, 100, 100);
    minute(CDN, 100, 100);
    look();
    vi.advanceTimersByTime(6 * 60_000);
    look();

    expect(shares()[CDN]).toBeGreaterThan(0.4);
  });
});
