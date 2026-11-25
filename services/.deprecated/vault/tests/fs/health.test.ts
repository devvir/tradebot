import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real filesystem over a temp data dir; the canary's payload write can be
// made to fail the way a full disk fails it.

const data = vi.hoisted(() => ({ dir: '/nonexistent-vault-test-dir', failWrite: null as NodeJS.ErrnoException | null }));

vi.mock('../../src/fs/paths', () => ({ get DATA_DIR() { return data.dir; } }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  return {
    ...actual,
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (data.failWrite) throw data.failWrite;

      return actual.writeSync(...args);
    },
  };
});

import { logger } from '@devvir/service-kit';
import {
  recordFailure, isHealthy, getFailureReason, setBackpressure, isThrottled, _test_reset,
} from '../../src/fs/health';

const RECOVERY_INTERVAL_MS = 5_000;

const enospc = (): NodeJS.ErrnoException => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const canary = (): string => path.join(data.dir, '.health-canary');

const goUnhealthy = (): void => {
  for (let i = 0; i < 5; i++) recordFailure(`failure ${i}`);
};

beforeEach(() => {
  vi.useFakeTimers();
  data.dir       = mkdirSync(path.join(os.tmpdir(), `vault-health-test-${Date.now()}-${Math.random()}`), { recursive: true }) as string;
  data.failWrite = null;
  _test_reset();
  vi.clearAllMocks();
});

afterEach(() => {
  _test_reset();
  vi.useRealTimers();
  rmSync(data.dir, { recursive: true, force: true });
});

describe('storage health', () => {
  it('stays healthy below five failures in a minute', () => {
    for (let i = 0; i < 4; i++) recordFailure('disk hiccup');

    expect(isHealthy()).toBe(true);
    expect(getFailureReason()).toBeNull();
  });

  it('goes unhealthy at five failures within a minute, with the last reason', () => {
    goUnhealthy();

    expect(isHealthy()).toBe(false);
    expect(getFailureReason()).toMatch(/5 write failures.*failure 4/);
  });

  it('does not count failures older than a minute', () => {
    for (let i = 0; i < 4; i++) recordFailure('old');

    vi.advanceTimersByTime(60_001);
    recordFailure('new');

    expect(isHealthy()).toBe(true);
  });
});

describe('recovery probe', () => {
  it('turns healthy again once a canary write succeeds, and removes the canary', () => {
    goUnhealthy();

    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);

    expect(isHealthy()).toBe(true);
    expect(getFailureReason()).toBeNull();
    expect(existsSync(canary())).toBe(false);
  });

  it('starts a fresh failure count after recovering', () => {
    goUnhealthy();
    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);

    for (let i = 0; i < 4; i++) recordFailure('again');

    expect(isHealthy()).toBe(true);
  });

  it('stays unhealthy while the canary cannot be written to a full disk, and leaves no canary', () => {
    data.failWrite = enospc();
    goUnhealthy();

    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);

    expect(isHealthy()).toBe(false);
    expect(existsSync(canary())).toBe(false);
  });

  it('keeps probing after a failed probe and recovers once the disk has room', () => {
    data.failWrite = enospc();
    goUnhealthy();

    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS * 3);
    expect(isHealthy()).toBe(false);

    data.failWrite = null;
    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);

    expect(isHealthy()).toBe(true);
  });

  it('stays unhealthy while the data directory cannot be written at all', () => {
    data.dir = path.join(data.dir, 'missing');
    goUnhealthy();

    vi.advanceTimersByTime(RECOVERY_INTERVAL_MS);

    expect(isHealthy()).toBe(false);
  });
});

describe('per-path backpressure', () => {
  it('throttles only the path it is set on', () => {
    setBackpressure('trade/20240101', true, 15);

    expect(isThrottled('trade', '20240101')).toBe(true);
    expect(isThrottled('trade', '20240102')).toBe(false);
    expect(isThrottled('quote', '20240101')).toBe(false);
  });

  it('clears the throttle when the path drains', () => {
    setBackpressure('trade/20240101', true, 15);
    setBackpressure('trade/20240101', false);

    expect(isThrottled('trade', '20240101')).toBe(false);
  });

  it('reports each transition once, however often it is set', () => {
    setBackpressure('trade/20240101', true, 15);
    setBackpressure('trade/20240101', true, 16);
    setBackpressure('trade/20240101', false);
    setBackpressure('trade/20240101', false);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
