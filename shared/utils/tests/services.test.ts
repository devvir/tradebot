import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings, Service, Spec } from '@devvir/service-kit';

vi.mock('@devvir/service-kit', () => ({
  default: { create: (config: { spec: Spec; bindings: Bindings }) => config },
  logger:  { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SKFactory } from '../src/services';

type Tracked = { spec: Spec; bindings: Bindings };

/** A service reduced to the state calls the bindings use, started the way service-kit starts one. */
const start = (trackMessages: Parameters<typeof SKFactory>[0]['trackMessages']) => {
  const { spec, bindings } = SKFactory({ name: 'test', trackMessages }) as unknown as Tracked;
  const state   = { ...(spec.state as Record<string, unknown>) };
  const service = {
    logger:    { info: vi.fn() },
    state:     (key: string) => state[key],
    setState:  (key: string, value: unknown) => { state[key] = value; },
    increment: (key: string) => { state[key] = (state[key] as number) + 1; },
  } as unknown as Service;

  bindings.onStarted!(service);

  const message = () => bindings.onMessage!(service);
  const health  = () => {
    const res = { status: 0, body: {} as Record<string, unknown>,
      writeHead(status: number) { this.status = status; },
      end(body: string) { this.body = JSON.parse(body); } };

    bindings.onHealthCheck!(service, res);

    return res;
  };

  return { message, health };
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('SKFactory message-tracking health', () => {
  it('is healthy within the startup grace before any message', () => {
    const { health } = start(true);

    vi.advanceTimersByTime(59_000);

    expect(health().status).toBe(200);
    expect(health().body).toMatchObject({ healthy: true, messages: 0, startedAt: 1_000_000, lastMessageAt: null });
  });

  it('is unhealthy once the startup grace passes without a message', () => {
    const { health } = start(true);

    vi.advanceTimersByTime(60_000);

    expect(health().status).toBe(503);
    expect(health().body).toMatchObject({ healthy: false, messages: 0 });
  });

  it('is healthy right after a message', () => {
    const { health, message } = start(true);

    vi.advanceTimersByTime(90_000);
    message();

    expect(health().status).toBe(200);
    expect(health().body).toMatchObject({ healthy: true, messages: 1, lastMessageAt: 1_090_000 });
  });

  it('is unhealthy once the inactivity limit passes since the last message', () => {
    const { health, message } = start(true);

    message();
    vi.advanceTimersByTime(29_000);
    expect(health().status).toBe(200);

    vi.advanceTimersByTime(1_000);
    expect(health().status).toBe(503);
  });

  it('takes its limits from the spec', () => {
    const { health, message } = start({ inactivityMs: 5_000, startupGraceMs: 10_000 });

    vi.advanceTimersByTime(10_000);
    expect(health().status).toBe(503);

    message();
    vi.advanceTimersByTime(4_000);
    expect(health().status).toBe(200);

    vi.advanceTimersByTime(1_000);
    expect(health().status).toBe(503);
  });

  it('adds no tracking when not asked to', () => {
    const { spec, bindings } = SKFactory({ name: 'test' }) as unknown as Tracked;

    expect(bindings).toEqual({});
    expect(spec.state).toBeUndefined();
  });
});
