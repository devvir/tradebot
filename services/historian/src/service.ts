import { SKFactory } from '@tradebot/utils';
import config from './config.js';

export default SKFactory({
  name: 'historian',
  mongodb: true,
}).declare({ config });
