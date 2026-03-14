import { SKFactory } from '@tradebot/utils';
import config from './config';
import { RabbitMQ } from '@devvir/service-kit';

export const QUEUE             = 'codec';
export const INBOUND_EXCHANGE  = 'codec.in';
export const OUTBOUND_EXCHANGE = 'codec.out';

const topology: RabbitMQ.TopologySpec = {
  exchanges: {
    [INBOUND_EXCHANGE]: {
      type:   'topic',
      queues: { [QUEUE]: { routingKey: '#' } },
    },
    [OUTBOUND_EXCHANGE]: {
      type: 'topic',
    },
  },
};

export default SKFactory({
  name: 'codec',
  rabbitmq: { topology },
  trackMessages: true,
}).declare({ config });
