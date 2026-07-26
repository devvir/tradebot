/**
 * Base class for strategies. Subclasses only need to implement `decide`.
 */

import type { Strategy, PseudoOrder } from './types';
import type { StrategyInput } from '../types';

export abstract class BaseStrategy implements Strategy {
  abstract name: string;

  abstract decide(data: StrategyInput): PseudoOrder[];
}
