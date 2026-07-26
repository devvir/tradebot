import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:          'distiller',
  mongodb:       true,
  redis:         true,
  trackMessages: true,
  state:         { stopping: false, distillers: 0 },
  config,
});
