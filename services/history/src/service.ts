import { SKFactory } from '@tradebot/utils';
import config from './config.js';

export default SKFactory({
  name: 'history',
  mongodb: true,
}).declare({ config });
