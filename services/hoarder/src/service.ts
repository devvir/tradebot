import { SKFactory } from '@tradebot/utils';
import config from './config';
import type { State } from './types';

const state = {
  isShuttingDown: false,
} satisfies State;

export default SKFactory({
  name: 'hoarder',
  rabbitmq: { topology: { exchanges: { hoarder: { type: 'topic' } } } },
  trackMessages: true,
  config,
  state,
});
