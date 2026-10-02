import { SKFactory } from '@tradebot/utils';
import config from './config';

/** Hauler serves nothing: it walks the catalog's buckets and writes files. */
export default SKFactory({
  name: 'hauler',
  config,
});
