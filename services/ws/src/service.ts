import { SKFactory } from '@tradebot/utils';
import config from './config';

const QUEUE_DELTAS = 'ws.deltas';

export default SKFactory({
  name: 'ws',
  rabbitmq: { topology: { queues: { [QUEUE_DELTAS]: {} } } },
  trackMessages: true,
}).declare({ config });
