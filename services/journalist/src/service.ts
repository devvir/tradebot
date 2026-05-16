import { SKFactory } from '@tradebot/utils';
import config from './config';
import { RabbitMQ } from '@devvir/service-kit';

const topology = {
  exchanges: {
    journalist: {
      type: 'topic',
      queues: { journalist: {} },
    },
  },
} as RabbitMQ.TopologySpec;

export default SKFactory({
  name:          'journalist',
  rabbitmq:      { topology },
  trackMessages: true,
  config,
});
