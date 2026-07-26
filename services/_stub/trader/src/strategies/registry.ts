/**
 * Strategy registry: name → { factory, defaults }.
 *
 * Adding a strategy: implement it as a `BaseStrategy`, then add one entry here.
 * Nothing else changes — `loadStrategy` and `availableStrategies` work off this map.
 */

import { RangeStrategy } from './range';
import type { StrategyEntry, Strategy, StrategyDefaults } from './types';

export const STRATEGIES: Record<string, StrategyEntry> = {
  range: {
    factory:  () => new RangeStrategy(),
    defaults: {
      name:           'range',
      dependencies:   ['quote', 'instrument'],
      tickIntervalMs: 30_000,
      amendThreshold: 0,
    },
  },
};

export function loadStrategy(name: string): { strategy: Strategy; defaults: StrategyDefaults } {
  const entry = STRATEGIES[name];

  if (! entry) {
    throw new Error(`Unknown strategy "${name}". Available: ${availableStrategies().join(', ')}`);
  }

  return { strategy: entry.factory(), defaults: entry.defaults };
}

export function availableStrategies(): string[] {
  return Object.keys(STRATEGIES);
}
