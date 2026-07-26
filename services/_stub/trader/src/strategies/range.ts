/**
 * Range strategy: place one buy and one sell each tick, both 1% off mid.
 *
 * Skateboard-grade: no levels, no size scaling, no inventory awareness. Used
 * to validate the end-to-end flow rather than to make money.
 */

import { BaseStrategy } from './strategy';
import type { PseudoOrder } from './types';
import type { StrategyInput } from '../types';

const OFFSET_PCT = 0.01;

export class RangeStrategy extends BaseStrategy {
  name = 'range';

  decide(data: StrategyInput): PseudoOrder[] {
    if (! data.quote) return [];

    const mid    = (data.quote.bidPrice + data.quote.askPrice) / 2;
    const offset = mid * OFFSET_PCT;

    return [
      { side: 'buy',  price: mid - offset },
      { side: 'sell', price: mid + offset },
    ];
  }
}
