import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:          'farmer',
  mongodb:       true,
  redis:         true,
  config,
});
