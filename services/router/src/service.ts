import { SKFactory } from '@tradebot/utils';
import config from './config';

// The router connects and closes its RabbitMQ brokers itself (see lifecycle.ts), so it declares
// no rabbitmq provider.
export default SKFactory({
  name: 'router',
  config,
});
