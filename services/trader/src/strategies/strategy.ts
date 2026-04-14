/**
 * Base strategy class/interface
 */

import type { Strategy, PseudoOrder } from './types';
import type { StrategyInput } from '../types';

export abstract class BaseStrategy implements Strategy {
  abstract name: string;

  protected symbol: string;

  constructor(symbol: string) {
    this.symbol = symbol;
  }

  abstract decide(data: StrategyInput): PseudoOrder[];
}
