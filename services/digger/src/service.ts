import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * Three servers (one ws, two express) on distinct ports, and two provider fetch
 * clients (the ws firehose + the dedicated rest instance). No mongo, no broker —
 * digger reads everything through the provider.
 */
export default SKFactory({
  name:    'digger',
  config,
  servers: [
    { name: 'ws',      type: 'ws',      port: config.wsPort },
    { name: 'rest',    type: 'express', port: config.restPort, basePath: '/api/v1' },
    { name: 'control', type: 'express', port: config.controlPort },
  ],
  clients: [
    { name: 'provider-ws',   url: config.providerWsUrl },
    { name: 'provider-rest', url: config.providerRestUrl },
  ],
});
