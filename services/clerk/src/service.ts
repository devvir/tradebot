import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:  'clerk',
  redis: true,
  config,
});
