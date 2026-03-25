import { SKFactory } from '@tradebot/utils';
import { publisherTopology, consumerTopology } from './topology';
import config from './config';

export default SKFactory({
  name: 'codec',
  trackMessages: true,
}).declare({
  config,

  providers: {
    consumer: {
      useBroker: true,
      provider: 'rabbitmq',
      url: config.rabbitmqUrl,
      topology: consumerTopology,
    },
    publisher: {
      useBroker: true,
      provider: 'rabbitmq',
      url: config.rabbitmqUrl,
      topology: publisherTopology,
    },
  }
});
