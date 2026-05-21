import { SKFactory } from '@tradebot/utils';
import config from './config.js';

export default SKFactory({
  name: 'registry',
  mongodb: true,
  config,
  servers: { name: 'api', type: 'express' },
});
