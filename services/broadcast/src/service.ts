import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'broadcast',
  rabbitmq: {
    topology: {
      exchanges: { broadcast: { type: 'topic' } },
    }
  },
  trackMessages: true,
}).declare({ config });
