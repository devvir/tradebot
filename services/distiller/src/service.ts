import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:          'distiller',
  mongodb:       true,
  trackMessages: true,
}).declare({ config });
