import { SKFactory } from '@tradebot/utils';
import { type RabbitMQ } from '@devvir/service-kit';
import config from './config';
import type { State } from './types';

const state: State = {
  store:       new Map(),
  guards:      new Map(),
  instruments: new Map(),
};

const topology: RabbitMQ.TopologySpec = {
  exchanges: {
    [config.exchange]: {
      type:   'topic',
      queues: {
        'teller.trade':      { routingKey: 'trade.insert' },
        'teller.instrument': { routingKey: ['instrument.partial', 'instrument.update'] },
      },
    },
  },
};

export default SKFactory({
  name:          'teller',
  rabbitmq:      { topology },
  mongodb:       true,
  trackMessages: true,
}).declare({ config: config as any, state: state as any });
