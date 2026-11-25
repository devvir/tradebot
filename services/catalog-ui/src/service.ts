import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * A browser for the catalog and for prospector's surveys, and nothing else.
 *
 * It stores nothing, decides nothing and surveys nothing. Every answer it shows
 * comes from the catalog's API or from prospector's, so a question this service
 * cannot answer is a question those APIs cannot answer — which is the point of
 * it: it is the place where an endpoint being unhelpful becomes obvious.
 */
export default SKFactory({
  name:   'catalog-ui',
  config,
  servers: { type: 'express', port: config.port },
});
