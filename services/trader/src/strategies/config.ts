/**
 * Strategy configurations and registry
 */

import type { StrategyConfig } from '../core/types';
import { RangeStrategy } from './range';
import type { Strategy } from './types';

/**
 * Static strategy configs — symbol is a default that the service overrides at runtime.
 */
export const STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
  range: {
    name:            'range',
    symbol:          'XBTUSD',
    dependencies:    ['quote', 'instrument'],
    tickIntervalMs:  30_000,
    amendThreshold:  0,
  },
};

export function loadStrategy(name: string, symbol: string): Strategy {
  if (name === 'range') {
    return new RangeStrategy(symbol);
  }

  throw new Error(`Unknown strategy: ${name}`);
}
