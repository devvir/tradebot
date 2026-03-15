import { SKFactory } from '@tradebot/utils';

export default SKFactory({
  name:          'snapshots',
  rabbitmq:      { topology: { queues: { snapshots: {} } } },
  trackMessages: true,
}).declare({ state: { snapshots: {} } });
