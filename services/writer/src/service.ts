import { SKFactory } from '@tradebot/utils';
import config from './config';
import { TopologySpec } from './types';

export const QUEUE = 'writer';

const EXCHANGE = 'writer';
const DLX      = 'writer.dlx';
const DLQ      = 'writer.dead-letter';

const topology: TopologySpec = {
  exchanges: {
    [EXCHANGE]: {
      type:   'topic',
      queues: { [QUEUE]: { routingKey: '#', deadLetterExchange: DLX } },
    },
    [DLX]: { type: 'fanout', queues: { [DLQ]: {} } },
  },
};

export default SKFactory({
  name: 'writer',
  mongodb: true,
  rabbitmq: { topology },
  trackMessages: true,
}).declare({ config });
