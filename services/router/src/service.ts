import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'router',
  rabbitmq: true,
  config,
  state: { counter: 0 },
});
