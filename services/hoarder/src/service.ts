import { SKFactory } from '@tradebot/utils';
import config from './config';
import { topologyFor } from './topology';
import type { State } from './types';

const state = {
  isShuttingDown: false,
} satisfies State;

export default SKFactory({
  name: 'hoarder',
  rabbitmq: { topology: topologyFor(config.queue) },
  trackMessages: true,
  config,
  state,
});
