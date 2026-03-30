import { describe, it, expect, vi } from 'vitest';
import type { RedisClient } from '@devvir/service-kit';
import { getOffset, setOffset, isDone, markDone } from '../src/progress';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRedis = (getResult: string | null = null) => ({
  get: vi.fn().mockResolvedValue(getResult),
  set: vi.fn().mockResolvedValue('OK'),
} as unknown as RedisClient);

// ── getOffset ─────────────────────────────────────────────────────────────────

describe('getOffset', () => {
  it('returns 0 when the key does not exist', async () => {
    const redis = makeRedis(null);

    expect(await getOffset(redis, 'trade', '20240101')).toBe(0);
  });

  it('returns 0 when the key is "done"', async () => {
    const redis = makeRedis('done');

    expect(await getOffset(redis, 'trade', '20240101')).toBe(0);
  });

  it('returns the stored integer offset', async () => {
    const redis = makeRedis('1500');

    expect(await getOffset(redis, 'trade', '20240101')).toBe(1500);
  });

  it('reads the key clerk_progress:table:date', async () => {
    const redis = makeRedis(null);

    await getOffset(redis, 'funding', '20240315');

    expect(redis.get).toHaveBeenCalledWith('clerk_progress:funding:20240315');
  });
});

// ── setOffset ─────────────────────────────────────────────────────────────────

describe('setOffset', () => {
  it('stores the offset as a string', async () => {
    const redis = makeRedis();

    await setOffset(redis, 'trade', '20240101', 500);

    expect(redis.set).toHaveBeenCalledWith('clerk_progress:trade:20240101', '500');
  });
});

// ── isDone ────────────────────────────────────────────────────────────────────

describe('isDone', () => {
  it('returns true when the key is "done"', async () => {
    const redis = makeRedis('done');

    expect(await isDone(redis, 'trade', '20240101')).toBe(true);
  });

  it('returns false when the key is a number string', async () => {
    const redis = makeRedis('1500');

    expect(await isDone(redis, 'trade', '20240101')).toBe(false);
  });

  it('returns false when the key does not exist', async () => {
    const redis = makeRedis(null);

    expect(await isDone(redis, 'trade', '20240101')).toBe(false);
  });
});

// ── markDone ──────────────────────────────────────────────────────────────────

describe('markDone', () => {
  it('sets the key to "done"', async () => {
    const redis = makeRedis();

    await markDone(redis, 'trade', '20240101');

    expect(redis.set).toHaveBeenCalledWith('clerk_progress:trade:20240101', 'done');
  });
});

