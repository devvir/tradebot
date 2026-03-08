import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pause, resume, paused, greenLight } from '../src/semaphore';

vi.mock('@devvir/service', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('semaphore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resume(); // Reset to clean state
  });

  afterEach(() => {
    resume();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is not paused initially', () => {
    expect(paused()).toBe(false);
  });

  it('pause() sets paused state', () => {
    pause(1000);
    expect(paused()).toBe(true);
  });

  it('resume() clears paused state', () => {
    pause(1000);
    resume();
    expect(paused()).toBe(false);
  });

  it('greenLight() resolves immediately when not paused', async () => {
    await expect(greenLight()).resolves.toBeUndefined();
  });

  it('greenLight() resolves after manual resume', async () => {
    pause(10_000);
    const p = greenLight();
    resume();
    await expect(p).resolves.toBeUndefined();
  });

  it('auto-resumes after the specified delay', () => {
    pause(1000);
    expect(paused()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(paused()).toBe(false);
  });

  it('calling pause() while already paused resets the timer', () => {
    pause(5000);
    vi.advanceTimersByTime(3000); // 3s elapsed — first timer should have fired at 5s
    expect(paused()).toBe(true);

    pause(1000); // Reset: should fire 1s from now, not 2s from now
    vi.advanceTimersByTime(999);
    expect(paused()).toBe(true); // Not yet

    vi.advanceTimersByTime(1);
    expect(paused()).toBe(false); // Exactly 1s after second pause
  });

  it('returns the same promise when called multiple times while paused', () => {
    const p1 = pause(1000);
    const p2 = pause(2000);
    expect(p1).toBe(p2);
  });
});
