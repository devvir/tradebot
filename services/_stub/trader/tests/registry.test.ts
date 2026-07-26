/**
 * Strategy registry tests.
 */

import { describe, it, expect } from 'vitest';
import { loadStrategy, availableStrategies, STRATEGIES } from '../src/strategies';

describe('loadStrategy', () => {
  it('returns a strategy instance and its defaults for a known name', () => {
    const { strategy, defaults } = loadStrategy('range');

    expect(strategy.name).toBe('range');
    expect(typeof strategy.decide).toBe('function');
    expect(defaults.dependencies).toContain('quote');
    expect(defaults.tickIntervalMs).toBeGreaterThan(0);
  });

  it('throws with the available list when the name is unknown', () => {
    expect(() => loadStrategy('not-a-strategy')).toThrow(/Unknown strategy/);
    expect(() => loadStrategy('not-a-strategy')).toThrow(/range/);
  });

  it('returns a fresh instance on each call', () => {
    const a = loadStrategy('range').strategy;
    const b = loadStrategy('range').strategy;

    expect(a).not.toBe(b);
  });
});

describe('availableStrategies', () => {
  it('lists every entry in the registry', () => {
    expect(availableStrategies()).toEqual(Object.keys(STRATEGIES));
  });

  it('includes range', () => {
    expect(availableStrategies()).toContain('range');
  });
});
