/**
 * Strategy module types
 */

import type { StrategyInput, DataDependency } from '../types';

export interface PseudoOrder {
  side:      'buy' | 'sell';
  price:     number;
  quantity?: number;
}

/**
 * A strategy is a pure decision-maker: given the current data snapshot, return
 * the orders it wants on the book. State (if any) lives on the instance.
 */
export interface Strategy {
  name: string;
  decide(data: StrategyInput): PseudoOrder[];
}

/**
 * Per-class defaults declared in the registry. Symbol is added at runtime to
 * produce a complete `StrategyConfig` (see core/types.ts).
 */
export interface StrategyDefaults {
  name:            string;
  dependencies:    DataDependency[];
  tickIntervalMs:  number;
  amendThreshold?: number;
}

/** A registry entry: how to build the strategy and its default config. */
export interface StrategyEntry {
  factory:  () => Strategy;
  defaults: StrategyDefaults;
}
