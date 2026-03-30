import { RabbitMQ } from '@devvir/service-kit';
import { SKFactory } from '@tradebot/utils';
import config from './config';

const topology = {
  exchanges: {
    clerk: { type: 'topic' },
  },
} as RabbitMQ.TopologySpec;

export default SKFactory({
  name: 'clerk',
  rabbitmq: { topology },
  redis: true,
}).declare({ config });
