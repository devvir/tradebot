import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'proxy',
  config,
  // Raw body parsing — request bodies are forwarded to BitMEX as bytes.
  // pingable: false keeps the proxy fully transparent (no path shadowed).
  servers: { name: 'api', type: 'express', raw: true, pingable: false },
});
