import { describe, it, expect, beforeEach } from 'vitest';
import * as clock from '../src/clock';

beforeEach(() => { clock._test_reset(); });

// ── Initial state ─────────────────────────────────────────────────────────────

describe('clock — initial state', () => {
  it('fetch() returns null before any set or update', () => {
    expect(clock.fetch()).toBeNull();
  });
});

// ── set ───────────────────────────────────────────────────────────────────────

describe('clock — set()', () => {
  it('sets the clock to the given value', () => {
    clock.set(1_000);
    expect(clock.fetch()).toBe(1_000);
  });

  it('can jump backwards (unlike update)', () => {
    clock.set(5_000);
    clock.set(2_000);
    expect(clock.fetch()).toBe(2_000);
  });

  it('can set to zero', () => {
    clock.set(0);
    expect(clock.fetch()).toBe(0);
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe('clock — update()', () => {
  it('sets the clock when it is null', () => {
    clock.update(1_000);
    expect(clock.fetch()).toBe(1_000);
  });

  it('advances when the new value is greater', () => {
    clock.set(1_000);
    clock.update(2_000);
    expect(clock.fetch()).toBe(2_000);
  });

  it('does not move backwards', () => {
    clock.set(5_000);
    clock.update(3_000);
    expect(clock.fetch()).toBe(5_000);
  });

  it('does not move on equal value', () => {
    clock.set(5_000);
    clock.update(5_000);
    expect(clock.fetch()).toBe(5_000);
  });
});

// ── _test_reset ───────────────────────────────────────────────────────────────

describe('clock — _test_reset()', () => {
  it('resets to null after set', () => {
    clock.set(9_999);
    clock._test_reset();
    expect(clock.fetch()).toBeNull();
  });
});
