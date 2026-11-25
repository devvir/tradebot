import { SKFactory } from '@tradebot/utils';
import config from './config';

/**
 * Hauler serves only its health check: it walks each venue's prefix of the catalog's bucket and
 * writes files.
 */
export default SKFactory({
  name: 'hauler',
  config,
});
