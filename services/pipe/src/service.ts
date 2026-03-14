import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:     'pipe',
  rabbitmq: true,
}).declare({ healthcheck: false, config });
