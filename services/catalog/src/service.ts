import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * The catalog's public API runs on service-kit's own express server: body
 * parsing, request logging, `/ping` and rate limiting come with it, and the
 * plugin stops it on shutdown. Routes are added in `api/` once the database is
 * open — there is nothing to serve before then.
 *
 * **Bodies up to 5 MB**, because a report forwarded from a downloader may name
 * thousands of files.
 */
export default SKFactory({
  name:    'catalog',
  config,
  servers: { type: 'express', port: config.port, json: { limit: '5mb' } },
});
