/**
 * Strategies module types
 */

import type { StrategyInput } from '../types';

export interface PseudoOrder {
  side:      'buy' | 'sell';
  price:     number;
  quantity?: number;
}

export interface Strategy {
  name: string;
  decide(data: StrategyInput): PseudoOrder[];
}
