import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * The catalog's public API runs on service-kit's own express server: request
 * logging and `/ping` come with it, and the plugin stops it on shutdown. Routes
 * are added in `api/` once the database is open — there is nothing to serve
 * before then.
 *
 * **Bodies are not parsed here**: `api/` reads them once a request has passed
 * the token check, and sets their limits.
 */
export default SKFactory({
  name:    'catalog',
  config,
  servers: { type: 'express', port: config.port, json: false },
});
