import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'tardy',
  redis: true,
  config,
  clients: {
    name:    'vault',
    type:    'fetch',
    url:     config.vaultUrl,
    // Vault failures are all transient from tardy's view — retry uncapped.
    retryOn: [429, 500, 502, 503, 504],
  },
});
