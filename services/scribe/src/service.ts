import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name: 'scribe',
  redis: true,
  config,
  clients: {
    name:    'vault',
    type:    'fetch',
    url:     config.vaultUrl,
    // Vault throttle (429) and storage-unhealthy (503) are transient — retry uncapped.
    retryOn: [429, 503],
  },
});
