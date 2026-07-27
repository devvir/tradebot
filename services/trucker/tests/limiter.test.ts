import { describe, it, expect, beforeEach } from 'vitest';
import { acquire, penalise, reward, _test_reset, _test_state } from '../src/limiter';

beforeEach(() => _test_reset());

describe('venue limiter', () => {
  it('spaces successive requests to one venue', async () => {
    const t0 = Date.now();

    await acquire('binance');
    await acquire('binance');
    await acquire('binance');

    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  // One venue's throttling must never slow another — they are unrelated servers.
  it('keeps venues independent', async () => {
    penalise('okx', 'HTTP 429');

    const t0 = Date.now();

    await acquire('binance');

    expect(Date.now() - t0).toBeLessThan(100);
    expect(_test_state.get('okx')!.until).toBeGreaterThan(Date.now());
  });

  it('doubles the cooldown on repeated pushback', () => {
    penalise('gate', 'HTTP 429');
    const first = _test_state.get('gate')!.cooldownMs;

    penalise('gate', 'HTTP 429');

    expect(_test_state.get('gate')!.cooldownMs).toBe(first * 2);
  });

  it('honours Retry-After when it exceeds our own cooldown', () => {
    penalise('kucoin', 'HTTP 429', 30_000);

    expect(_test_state.get('kucoin')!.until - Date.now()).toBeGreaterThan(20_000);
  });

  it('decays the cooldown as clean responses come back', () => {
    penalise('bybit', 'HTTP 503');
    penalise('bybit', 'HTTP 503');

    const peak = _test_state.get('bybit')!.cooldownMs;

    reward('bybit');

    expect(_test_state.get('bybit')!.cooldownMs).toBe(peak / 2);
  });
});
