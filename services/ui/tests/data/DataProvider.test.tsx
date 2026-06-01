import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DataProvider, useBitmex, useDigger } from '../../src/data/DataProvider';
import { EnvProvider, useEnv } from '../../src/data/EnvProvider';
import { ENV_CONFIGS } from '../../src/data/envs';

const STORAGE_KEY = 'tradebot.ui.env';

/** Track BitmexClient instances created during the test. */
const bitmexCtors: Array<{ restUrl: string; wsUrl: string; headers: Record<string, string> }> = [];
const destroyed   = vi.fn();

vi.mock('../../src/data/BitmexClient', () => ({
  BitmexClient: class {
    constructor(public restUrl: string, public wsUrl: string, public headers: Record<string, string> = {}) {
      bitmexCtors.push({ restUrl, wsUrl, headers });
    }
    destroy() { destroyed(); }
  },
}));

vi.mock('../../src/data/DiggerClient', () => ({
  DiggerClient: class {
    constructor(public baseUrl: string) {}
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <EnvProvider>
    <DataProvider>{children}</DataProvider>
  </EnvProvider>
);

beforeEach(() => {
  localStorage.clear();
  bitmexCtors.length = 0;
  destroyed.mockClear();
  globalThis.__REPLAY_ENABLED__ = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Client construction per env ───────────────────────────────────────────────

describe('DataProvider — builds clients from the current env config', () => {
  it('builds a BitmexClient with the live env config by default', () => {
    renderHook(() => useBitmex(), { wrapper });

    expect(bitmexCtors[0]).toEqual({
      restUrl: ENV_CONFIGS.live.restPath,
      wsUrl:   ENV_CONFIGS.live.wsUrl,
      headers: ENV_CONFIGS.live.headers,
    });
  });

  it('builds a BitmexClient with testnet config when env is testnet', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('testnet'));

    renderHook(() => useBitmex(), { wrapper });

    expect(bitmexCtors[0]).toEqual({
      restUrl: ENV_CONFIGS.testnet.restPath,
      wsUrl:   ENV_CONFIGS.testnet.wsUrl,
      headers: ENV_CONFIGS.testnet.headers,
    });
  });
});

// ── Digger gating ─────────────────────────────────────────────────────────────

describe('DataProvider — digger is gated on env + __REPLAY_ENABLED__', () => {
  it('returns null from useDigger for live env', () => {
    const { result } = renderHook(() => useDigger(), { wrapper });

    expect(result.current).toBeNull();
  });

  it('returns null from useDigger for testnet env', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('testnet'));

    const { result } = renderHook(() => useDigger(), { wrapper });

    expect(result.current).toBeNull();
  });

  it('returns a DiggerClient when env is replay and replay is enabled', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('replay'));

    const { result } = renderHook(() => useDigger(), { wrapper });

    expect(result.current).not.toBeNull();
  });

  it('returns null when env is replay but __REPLAY_ENABLED__ is false', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('replay'));
    globalThis.__REPLAY_ENABLED__ = false;

    const { result } = renderHook(() => useDigger(), { wrapper });

    expect(result.current).toBeNull();
  });
});

// ── Hook-guard errors ─────────────────────────────────────────────────────────

describe('DataProvider — hook guards', () => {
  it('useBitmex throws when used outside DataProvider', () => {
    expect(() => renderHook(() => useBitmex())).toThrow(/DataProvider/);
  });

  it('useDigger returns null when used outside DataProvider (no provider context)', () => {
    const { result } = renderHook(() => useDigger());

    expect(result.current).toBeNull();
  });
});

// ── Env switch lifecycle ──────────────────────────────────────────────────────

describe('DataProvider — recreates the client on env change', () => {
  it('creates a new BitmexClient when env switches', () => {
    const { result } = renderHook(
      () => ({ env: useEnv(), client: useBitmex() }),
      { wrapper },
    );

    expect(bitmexCtors).toHaveLength(1);

    act(() => result.current.env.setEnv('testnet'));

    /** A second BitmexClient is constructed with the testnet config. */
    const next = bitmexCtors[bitmexCtors.length - 1];

    expect(next.wsUrl).toBe(ENV_CONFIGS.testnet.wsUrl);
    expect(next.headers).toEqual(ENV_CONFIGS.testnet.headers);
  });
});
