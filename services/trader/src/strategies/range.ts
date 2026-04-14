/**
 * Range strategy: places buy and sell orders 1% away from mid price
 */

import { BaseStrategy } from './strategy';
import type { PseudoOrder } from './types';
import type { StrategyInput } from '../types';

export class RangeStrategy extends BaseStrategy {
  name = 'range';

  decide(data: StrategyInput): PseudoOrder[] {
    if (! data.quote) {
      return [];
    }

    const mid = (data.quote.bidPrice + data.quote.askPrice) / 2;
    const offset = mid * 0.01; // 1% offset

    return [
      {
        side: 'buy',
        price: mid - offset,
      },
      {
        side: 'sell',
        price: mid + offset,
      },
    ];
  }
}
