import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'rest',
  config,
  // Proxy: no body parsing — http-proxy-middleware streams request bodies through untouched.
  servers: { name: 'api', type: 'express', json: false },
});
