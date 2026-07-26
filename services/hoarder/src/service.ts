import { SKFactory } from '@tradebot/utils';
import config from './config';

const state = {
  broker: null,
  isShuttingDown: false,
  lastMessageTime: Date.now(),
};

export default SKFactory({
  name: 'hoarder',
  rabbitmq: { topology: { exchanges: { hoarder: { type: 'topic' } } } },
  trackMessages: true,
  config,
  state,
});
