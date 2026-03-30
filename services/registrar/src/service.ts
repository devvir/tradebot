import type { RabbitMQ } from '@devvir/service-kit';
import { SKFactory } from '@tradebot/utils';
import config from './config';

const EXCHANGE = 'registrar';
const QUEUE    = 'registrar';

const topology = {
  exchanges: {
    [EXCHANGE]: {
      type:   'fanout',
      queues: { [QUEUE]: {} },
    },
  },
} as RabbitMQ.TopologySpec;


export default SKFactory({
  name: 'registrar',
  mongodb: true,
  rabbitmq: { topology },
  trackMessages: true,
}).declare({ config });
