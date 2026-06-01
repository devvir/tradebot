import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get, set, remove } from '../../src/utils/storage';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── get ───────────────────────────────────────────────────────────────────────

describe('storage.get', () => {
  it('returns the fallback when key is absent', () => {
    expect(get('missing', 'fallback')).toBe('fallback');
  });

  it('parses and returns a stored object', () => {
    localStorage.setItem('k', JSON.stringify({ a: 1, b: [2, 3] }));

    expect(get<{ a: number; b: number[] }>('k', { a: 0, b: [] })).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses primitives — strings, numbers, booleans, null', () => {
    localStorage.setItem('s', JSON.stringify('hello'));
    localStorage.setItem('n', JSON.stringify(42));
    localStorage.setItem('b', JSON.stringify(true));
    localStorage.setItem('z', JSON.stringify(null));

    expect(get('s', '')).toBe('hello');
    expect(get('n', 0)).toBe(42);
    expect(get('b', false)).toBe(true);
    expect(get<null | string>('z', 'fb')).toBe(null);
  });

  it('returns the fallback when stored value is invalid JSON', () => {
    localStorage.setItem('k', '{not json');

    expect(get('k', 'fb')).toBe('fb');
  });

  it('returns the fallback when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });

    expect(get('k', 42)).toBe(42);
  });
});

// ── set ───────────────────────────────────────────────────────────────────────

describe('storage.set', () => {
  it('writes a JSON-serialized value', () => {
    set('k', { a: 1, b: [2, 3] });

    expect(localStorage.getItem('k')).toBe(JSON.stringify({ a: 1, b: [2, 3] }));
  });

  it('overwrites a previous value', () => {
    set('k', 'first');
    set('k', 'second');

    expect(localStorage.getItem('k')).toBe(JSON.stringify('second'));
  });

  it('swallows errors when setItem throws (quota / disabled)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

    expect(() => set('k', 'v')).not.toThrow();
  });
});

// ── remove ────────────────────────────────────────────────────────────────────

describe('storage.remove', () => {
  it('removes a key', () => {
    localStorage.setItem('k', 'v');

    remove('k');

    expect(localStorage.getItem('k')).toBeNull();
  });

  it('is a no-op for missing keys', () => {
    expect(() => remove('missing')).not.toThrow();
  });

  it('swallows errors when removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });

    expect(() => remove('k')).not.toThrow();
  });
});
