import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * Initial state shape. The replay clock and snapshots accumulator are module
 * singletons (clock/, snapshots/) — not part of state — because they're shared
 * by both the WS streaming engine and the REST API.
 */
const state = {
  subscriptions:  new Map(),
  buffers:        new Map(),
  broker:         null,
  isShuttingDown: false,
  isPaused:       false,
};

export default SKFactory({
  name:          'digger',
  rabbitmq:      { topology: { exchanges: { replay: { type: 'topic' } } } },
  mongodb:       true,
  trackMessages: true,
}).declare({ config, state });
