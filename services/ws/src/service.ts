import { RabbitMQ } from '@devvir/service-kit';
import { SKFactory } from '@tradebot/utils';
import config from './config';

const EXCHANGE = 'deltas';
const QUEUE    = 'ws.deltas';

const topology = {
  exchanges: {
    [EXCHANGE]: {
      type: 'topic',
      queues: { [QUEUE]: {} },
    },
  },
} as RabbitMQ.TopologySpec;

export default SKFactory({
  name: 'ws',
  rabbitmq: { topology },
  trackMessages: true,
  config,
});
