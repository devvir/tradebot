import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:    'writer',
  mongodb: true,
  config,
});
