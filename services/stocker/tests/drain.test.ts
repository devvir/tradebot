import { logger } from '@devvir/service-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scans, drain } from '../src/drain';

/**
 * Sweeps on a timer, and what a shutdown does to them: nothing more starts,
 * the sweep running is waited for — up to the bound, and no longer.
 */

const said = (fn: typeof logger.warn): string =>
  vi.mocked(fn).mock.calls.map(call => String(call[1])).join(' | ');

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => vi.clearAllMocks());

describe('the sweeps', () => {
  it('sweep again on the timer, never two at once', async () => {
    const scans = new Scans(10);
    let running = 0;
    let most    = 0;
    let passes  = 0;

    await scans.start(async () => {
      passes++;
      most = Math.max(most, ++running);
      await tick(35);
      running--;
    });

    await tick(150);
    await scans.drain(1_000);

    expect(passes).toBeGreaterThan(1);
    expect(most).toBe(1);
  });

  it('start no other once drained', async () => {
    const scans = new Scans(10);
    let passes  = 0;

    await scans.start(async () => { passes++; });
    await scans.drain(1_000);

    const after = passes;

    await tick(60);

    expect(passes).toBe(after);
  });

  it('tell the sweep running to stop, and wait for it to finish', async () => {
    const scans = new Scans(60_000);
    let told    = false;
    let done    = false;
    let started = (): void => {};

    const running = new Promise<void>(resolve => { started = resolve; });

    void scans.start(async stop => {
      started();
      await new Promise(resolve => stop.addEventListener('abort', resolve));
      told = true;
      await tick(30);
      done = true;
    });

    await running;

    expect(await scans.drain(1_000)).toBe(true);
    expect(told && done).toBe(true);
  });
});

describe('a shutdown', () => {
  it('closes the engine and the threads once the sweep is drained', async () => {
    const scans  = new Scans(60_000);
    const engine = vi.fn();
    const pool   = vi.fn(async () => {});

    await scans.start(async () => {});
    await drain(scans, 1_000, { engine, pool });

    expect(engine).toHaveBeenCalledOnce();
    expect(pool).toHaveBeenCalledOnce();
  });

  it('gives up at the bound, and leaves the engine open under the sweep still running', async () => {
    const scans  = new Scans(60_000);
    const engine = vi.fn();
    const pool   = vi.fn(async () => {});
    let started  = (): void => {};

    const running = new Promise<void>(resolve => { started = resolve; });

    void scans.start(async () => { started(); await new Promise(() => {}); });
    await running;

    const from = performance.now();

    await drain(scans, 100, { engine, pool });

    expect(performance.now() - from).toBeLessThan(1_000);
    expect(engine).not.toHaveBeenCalled();
    expect(pool).toHaveBeenCalledOnce();
    expect(said(logger.warn)).toContain('Drain ran out of time');
  });
});
