import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@devvir/service-kit';
import type { RunnerOf } from '../src/run';
import type { Haulable, Walked } from '../src/types';

const cfg = vi.hoisted(() => ({ archivesDir: '', catalogApi: '', catalogToken: '', venues: [], lens: '', concurrency: 2, minFreeGb: 0 }));

vi.mock('../src/config', () => ({ default: cfg }));

const { makeRunner } = await import('../src/run');
const { dropHeld, dropStale, hold, startWalk, taken } = await import('../src/held');
const { partialOf } = await import('../src/store');

/**
 * Each venue walked again and again, sooner or later by what the last walk
 * found, and a stop that waits for the files in flight only so long. See `run.ts`.
 */

const FOUND  = 5 * 60_000;
const QUIET  = 30 * 60_000;
const FLIGHT = 15_000;
const RETRY  = 60_000;

const walked = (over: Partial<Walked> = {}): Walked =>
  ({ listed: 0, progressed: 0, failed: 0, mismatched: 0, unreached: 0, full: false, cut: false, nothingOwed: false, ...over });

/** A runner whose walks answer `walks` in turn, the last one for every walk after. */
const runnerOf = (walks: ((stopped: () => boolean) => Promise<Walked>)[], over: Partial<RunnerOf> = {}) => {
  const at: number[] = [];

  const deps = {
    walkVenue: vi.fn(async (_venue: string, stopped: () => boolean) => {
      at.push(Date.now());

      return walks[Math.min(at.length, walks.length) - 1]!(stopped);
    }),
    startWalk: vi.fn(),
    dropHeld:  vi.fn(async () => 0),
    dropStale: vi.fn(async () => 0),
    halt:      vi.fn(),
    abandon:   vi.fn(),
    minFreeGb: 25,
    foundMs:   FOUND,
    quietMs:   QUIET,
    flightMs:  FLIGHT,
    retryMs:   RETRY,
    ...over,
  };

  return { runner: makeRunner(deps), deps, at };
};

/** Stop a runner whose walks are all quick, and wait for every loop to end. */
const stop = async (runner: ReturnType<typeof makeRunner>, running: Promise<void>): Promise<void> => {
  const stopped = runner.stopAfterFlight();

  await vi.advanceTimersByTimeAsync(1_000);
  await stopped;
  await running;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a venue', () => {
  it('is walked again soon after a walk that brought files, and later after one that did not', async () => {
    const { runner, at } = runnerOf([
      async () => walked({ listed: 2, progressed: 2 }),
      async () => walked({ listed: 2, failed: 2 }),
    ]);

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(FOUND + QUIET + 1);
    await stop(runner, running);

    expect(at.length).toBe(3);
    expect(at[1]! - at[0]!).toBe(FOUND);
    expect(at[2]! - at[1]!).toBe(QUIET);
  });

  it('is walked again only later after a walk that ran out of space, even with files brought', async () => {
    const { runner, at } = runnerOf([async () => walked({ listed: 2, progressed: 1, full: true })]);

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(QUIET + 1);
    await stop(runner, running);

    expect(at.length).toBe(2);
    expect(at[1]! - at[0]!).toBe(QUIET);
  });

  it('drops everything held of it after a walk in which it owed nothing, and only then', async () => {
    const { runner, deps } = runnerOf([
      async () => walked({ listed: 1, mismatched: 1 }),
      async () => walked({ full: true }),
      async () => walked({ nothingOwed: true }),
    ]);

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(QUIET + 1);
    expect(deps.dropHeld).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(QUIET);
    await stop(runner, running);

    expect(deps.dropHeld).toHaveBeenCalledTimes(1);
    expect(deps.dropHeld).toHaveBeenCalledWith('binance');
  });

  it('drops what was held long ago and not listed since only after a walk that went through what is owed', async () => {
    let release = (): void => undefined;
    const { runner, deps } = runnerOf([
      async () => walked({ listed: 1, mismatched: 1 }),
      async () => walked({ listed: 2, progressed: 1, full: true }),
      () => new Promise(resolve => { release = () => resolve(walked({ listed: 1 })); }),
    ], {
      // The walk in flight ends as the stop is asked for.
      halt: vi.fn(() => release()),
    });

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.startWalk).toHaveBeenCalledTimes(1);
    expect(deps.dropStale).toHaveBeenCalledTimes(1);

    // Full: what it did not reach may still be owed.
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(deps.startWalk).toHaveBeenCalledTimes(2);
    expect(deps.dropStale).toHaveBeenCalledTimes(1);

    // Stopped: the same.
    await vi.advanceTimersByTimeAsync(QUIET);
    expect(deps.startWalk).toHaveBeenCalledTimes(3);
    await stop(runner, running);

    expect(deps.dropStale).toHaveBeenCalledTimes(1);
    expect(deps.dropHeld).not.toHaveBeenCalled();
  });

  it('is walked again later after a walk that failed, and its loop carries on', async () => {
    const error = vi.spyOn(logger, 'error');
    const { runner, at } = runnerOf([
      async () => { throw new Error('boom'); },
      async () => walked({ listed: 1, progressed: 1 }),
    ]);

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(QUIET + FOUND + 1);
    await stop(runner, running);

    expect(at.length).toBe(3);
    expect(at[1]! - at[0]!).toBe(QUIET);
    expect(at[2]! - at[1]!).toBe(FOUND);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ venue: 'binance' }), 'Walk failed — trying again later');
  });

  it('walks on its own loop, whatever another venue is doing', async () => {
    const { runner, deps } = runnerOf([async () => walked()], {
      walkVenue: vi.fn(async (venue: string) => {
        if (venue === 'gate') throw new Error('boom');

        return walked({ listed: 1, progressed: 1 });
      }),
    });

    const running = runner.start(['binance', 'gate']);

    await vi.advanceTimersByTimeAsync(QUIET + 1);
    await stop(runner, running);

    const calls = vi.mocked(deps.walkVenue).mock.calls.map(([venue]) => venue);

    // Binance walks every FOUND (at 0, 5, … 30 minutes); gate, failing, every QUIET.
    expect(calls.filter(venue => venue === 'binance')).toHaveLength(QUIET / FOUND + 1);
    expect(calls.filter(venue => venue === 'gate')).toHaveLength(2);
  });
});

describe('a download held for the catalog to rule on', () => {
  const key = 'binance/spot/trades/B/BTC/202001/x.zip';
  const one: Haulable = { venue: 'binance', key, server: '', path: 'x.zip' };

  /**
   * Walk binance on the real held list, the first walk holding a download and
   * the last asking the runner to stop; answers whether its partial was there as
   * each later walk started, and once every walk was over.
   */
  const walkThrough = async (walks: ((at: number) => Walked)[]): Promise<boolean[]> => {
    const kept: boolean[] = [];
    const path = join(cfg.archivesDir, key);
    let n = 0;

    const runner = makeRunner({
      walkVenue: async () => {
        n++;

        if (n > 1) kept.push(existsSync(partialOf(path)));

        if (n === 1) {
          mkdirSync(dirname(partialOf(path)), { recursive: true });
          writeFileSync(partialOf(path), 'what was served');
          hold(one, path, 15, '');
        }

        if (n === walks.length) void runner.stopAfterFlight();

        return walks[n - 1]!(n);
      },
      startWalk, dropHeld, dropStale, halt: () => undefined, abandon: () => undefined,
      minFreeGb: 25, foundMs: 1, quietMs: 1, flightMs: 1_000, retryMs: 1,
    });

    await runner.start(['binance']);

    kept.push(existsSync(partialOf(path)));

    return kept;
  };

  beforeEach(() => {
    vi.useRealTimers();
    cfg.archivesDir = mkdtempSync(join(tmpdir(), 'run-'));
  });

  afterEach(async () => {
    await dropHeld('binance');
    rmSync(cfg.archivesDir, { recursive: true, force: true });
  });

  it('is dropped, and its partial removed, once two walks through what is owed have not listed its file', async () => {
    const owed = () => walked({ listed: 3, progressed: 3 });

    // Seen as each later walk starts, then after the last: kept after the walk that held it and the next, gone after the one after.
    expect(await walkThrough([() => walked({ listed: 1, mismatched: 1 }), owed, owed, owed])).toEqual([true, true, false, false]);
    expect(taken(one)).toBeUndefined();
  });

  it('is kept through walks that ended for want of room, with nothing settled', async () => {
    const full = () => walked({ full: true });

    expect(await walkThrough([() => walked({ listed: 1, mismatched: 1 }), full, full, full, full])).toEqual([true, true, true, true, true]);
    expect(taken(one)?.path).toBe(join(cfg.archivesDir, key));
  });

  it('is kept through walks whose listing ended early, which say nothing of what they did not list', async () => {
    const cut = () => walked({ listed: 2, progressed: 2, cut: true });

    expect(await walkThrough([() => walked({ listed: 1, mismatched: 1 }), cut, cut, cut, cut])).toEqual([true, true, true, true, true]);
    expect(taken(one)?.path).toBe(join(cfg.archivesDir, key));
  });
});

describe('a stop', () => {
  it('ends a loop that is resting, within a second, without giving anything up', async () => {
    const { runner, deps, at } = runnerOf([async () => walked()]);

    const running = runner.start(['binance']);
    let ended = false;

    void running.then(() => { ended = true; });

    await vi.advanceTimersByTimeAsync(60_000);

    const stopped = runner.stopAfterFlight();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(ended).toBe(true);
    await stopped;

    expect(at.length).toBe(1);
    expect(deps.halt).toHaveBeenCalledTimes(1);
    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('waits for the files in flight that finish in time, and gives up none', async () => {
    let release = (): void => undefined;
    const { runner, deps } = runnerOf([() => new Promise(resolve => { release = () => resolve(walked({ listed: 1, progressed: 1 })); })]);

    const running = runner.start(['binance']);

    await vi.advanceTimersByTimeAsync(1);

    const stopped = runner.stopAfterFlight();

    await vi.advanceTimersByTimeAsync(FLIGHT / 2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    await running;

    expect(deps.abandon).not.toHaveBeenCalled();
  });

  it('takes no new file, stops waiting for the catalog at once, and gives up what is still in flight after the flight', async () => {
    let release = (): void => undefined;
    let told: (() => boolean) | undefined;
    const { runner, deps } = runnerOf([(stopped) => {
      told = stopped;

      return new Promise(resolve => { release = () => resolve(walked({ listed: 1, unreached: 1 })); });
    }], {
      abandon: vi.fn(() => release()),
    });

    const running = runner.start(['binance']);
    let done = false;

    await vi.advanceTimersByTimeAsync(1);
    expect(told?.()).toBe(false);

    const stopped = runner.stopAfterFlight().then(() => { done = true; });

    expect(told?.()).toBe(true);
    expect(deps.halt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLIGHT - 1);
    expect(deps.abandon).not.toHaveBeenCalled();
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.abandon).toHaveBeenCalledTimes(1);

    await stopped;
    await running;

    expect(done).toBe(true);
    expect(deps.walkVenue).toHaveBeenCalledTimes(1);
  });

  it('with nothing started, ends at once', async () => {
    const { runner, deps } = runnerOf([async () => walked()]);

    await runner.stopAfterFlight();

    expect(deps.abandon).not.toHaveBeenCalled();
  });
});

describe('an ask until answered', () => {
  it('is asked again a retry apart until it answers', async () => {
    const { runner } = runnerOf([async () => walked()]);
    const at: number[] = [];
    const ask = vi.fn(async () => {
      at.push(Date.now());

      if (at.length < 3) throw new Error('refused');

      return 'venues';
    });

    const answered = runner.untilAnswered(ask);

    await vi.advanceTimersByTimeAsync(2 * RETRY);

    expect(await answered).toBe('venues');
    expect(at.length).toBe(3);
    expect(at[1]! - at[0]!).toBe(RETRY);
    expect(at[2]! - at[1]!).toBe(RETRY);
  });
});
