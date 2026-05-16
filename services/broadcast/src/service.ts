import { SKFactory } from '@tradebot/utils';
import config from './config';

const state = {
  realtime: null,
  platform: null,
  broker: null,
  isShuttingDown: false,
  lastMessageTime: Date.now(),
  apiVersion: null,
};

export default SKFactory({
  name: 'broadcast',
  rabbitmq: { topology: { exchanges: { broadcast: { type: 'topic' } } } },
  trackMessages: true,
  config,
  state,
});
