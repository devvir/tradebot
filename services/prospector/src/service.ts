import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * The catalog API runs on service-kit's own express server rather than one this
 * service stands up: body parsing, request logging, `/ping` and rate limiting
 * come with it, and the plugin stops it on shutdown without being asked.
 *
 * Routes and the token check are added in `api/`, once the catalog is open —
 * there is nothing to serve before then.
 */
export default SKFactory({
  name:   'prospector',
  config,
  servers: { type: 'express', port: config.port },
});
