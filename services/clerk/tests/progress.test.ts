import { describe, it, expect, vi } from 'vitest';
import type { RedisClient } from '@devvir/service-kit';
import { readProgress } from '../src/progress';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRedis = (getResult: string | null = null) => ({
  get: vi.fn().mockResolvedValue(getResult),
  set: vi.fn().mockResolvedValue('OK'),
} as unknown as RedisClient);

// ── readProgress ──────────────────────────────────────────────────────────────

describe('readProgress', () => {
  it('returns done when the key is "done:<count>"', async () => {
    const redis = makeRedis('done:100');

    expect(await readProgress(redis, 'trade', '20240101')).toEqual({ state: 'done' });
  });

  it('returns done when the key is "done:0" (empty bucket)', async () => {
    const redis = makeRedis('done:0');

    expect(await readProgress(redis, 'trade', '20240101')).toEqual({ state: 'done' });
  });

  it('returns startFrom 0 when the key does not exist', async () => {
    const redis = makeRedis(null);

    expect(await readProgress(redis, 'trade', '20240101')).toEqual({ state: 'pending', startFrom: 0 });
  });

  it('returns startFrom = stored + 1 when the key holds a number', async () => {
    const redis = makeRedis('1500');

    expect(await readProgress(redis, 'trade', '20240101')).toEqual({ state: 'pending', startFrom: 1501 });
  });

  it('reads the key customs:table:date', async () => {
    const redis = makeRedis(null);

    await readProgress(redis, 'funding', '20240315');

    expect(redis.get).toHaveBeenCalledWith('customs:funding:20240315');
  });
});
