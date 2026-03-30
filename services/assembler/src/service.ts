import type { RabbitMQ } from '@devvir/service-kit';
import { SKFactory } from '@tradebot/utils';
import config from './config';

const consumerTopology = {
  exchanges: {
    assembler: {
      type: 'fanout',
      queues: { assembler: {} },
    },
  },
} as RabbitMQ.TopologySpec;

const publisherTopology = {
  exchanges: {
    assembled: { type: 'topic' },
  },
} as RabbitMQ.TopologySpec;

export default SKFactory({
  name: 'assembler',
  trackMessages: true,
}).declare({
  config,

  providers: {
    consumer: {
      provider: 'rabbitmq',
      useBroker: true,
      url: config.queueUrl,
      topology: consumerTopology,
    },
    publisher: {
      provider: 'rabbitmq',
      useBroker: true,
      url: config.queueUrl,
      topology: publisherTopology,
    },
  },
});
