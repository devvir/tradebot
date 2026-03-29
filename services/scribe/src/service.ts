import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'scribe',
  redis: true,
}).declare({ config });
