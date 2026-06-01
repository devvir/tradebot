import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EnvProvider, useEnv } from '../../src/data/EnvProvider';

const STORAGE_KEY = 'tradebot.ui.env';

const wrapper = ({ children }: { children: ReactNode }) => <EnvProvider>{children}</EnvProvider>;

beforeEach(() => {
  localStorage.clear();
});

// ── useEnv ────────────────────────────────────────────────────────────────────

describe('EnvProvider — initial state', () => {
  it('defaults to live on first load', () => {
    const { result } = renderHook(() => useEnv(), { wrapper });

    expect(result.current.env).toBe('live');
  });

  it('restores the env saved in localStorage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('testnet'));

    const { result } = renderHook(() => useEnv(), { wrapper });

    expect(result.current.env).toBe('testnet');
  });

  it('falls back to live when stored value is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    const { result } = renderHook(() => useEnv(), { wrapper });

    expect(result.current.env).toBe('live');
  });
});

describe('EnvProvider — setEnv', () => {
  it('updates the env and persists to localStorage', () => {
    const { result } = renderHook(() => useEnv(), { wrapper });

    act(() => result.current.setEnv('replay'));

    expect(result.current.env).toBe('replay');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify('replay'));
  });

  it('overwrites a previously persisted value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('testnet'));

    const { result } = renderHook(() => useEnv(), { wrapper });

    act(() => result.current.setEnv('live'));

    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify('live'));
  });
});

describe('useEnv outside provider', () => {
  it('throws a descriptive error', () => {
    expect(() => renderHook(() => useEnv())).toThrow(/EnvProvider/);
  });
});
