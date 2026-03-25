import { RabbitMQ } from '@devvir/service-kit';

const QUEUE             = 'codec';
const INBOUND_EXCHANGE  = 'codec.in';
const OUTBOUND_EXCHANGE = 'codec.out';

export const consumerTopology: RabbitMQ.TopologySpec = {
  exchanges: {
    [INBOUND_EXCHANGE]: {
      type:   'topic',
      queues: { [QUEUE]: { routingKey: '#' } },
    },
  },
};

export const publisherTopology: RabbitMQ.TopologySpec = {
  exchanges: {
    [OUTBOUND_EXCHANGE]: {
      type: 'topic',
    },
  },
};