/**
 * Core module types
 */

import type { StrategyDefaults } from '../strategies/types';

/**
 * Runtime strategy configuration: registry defaults + the symbol to trade.
 * Built by `index.ts` from the chosen strategy entry and the env-supplied symbol.
 */
export interface StrategyConfig extends StrategyDefaults {
  symbol: string;
}
