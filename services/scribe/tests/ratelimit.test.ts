import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitIfNeeded } from '../src/utils/throttling';

const makeResponse = (status: number, remaining?: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      remaining !== undefined ? { 'x-ratelimit-remaining': String(remaining) } : {}
    ),
    json: () => Promise.resolve([]),
  } as unknown as Response);

describe('waitIfNeeded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when remaining >= 100', async () => {
    const start = Date.now();
    await waitIfNeeded(makeResponse(200, 100));
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('sleeps (100 - remaining) * 500ms when remaining < 100', async () => {
    const promise = waitIfNeeded(makeResponse(200, 90));
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
  });

  it('sleeps 10s when remaining is 80', async () => {
    const promise = waitIfNeeded(makeResponse(200, 80));
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
  });

  it('sleeps 50s when remaining is 0', async () => {
    const promise = waitIfNeeded(makeResponse(200, 0));
    await vi.advanceTimersByTimeAsync(50_000);
    await promise;
  });

  it('resolves immediately when header is missing', async () => {
    const start = Date.now();
    await waitIfNeeded(makeResponse(200));
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('sleeps 60s on 429', async () => {
    const promise = waitIfNeeded(makeResponse(429));
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;
  });

  it('sleeps 3s on other HTTP errors', async () => {
    const promise = waitIfNeeded(makeResponse(500));
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;
  });
});
