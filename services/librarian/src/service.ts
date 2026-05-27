import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:    'librarian',
  mongodb: true,
  config,
  /** Farmer POSTs over a pooled keep-alive client (undici); hold idle
   *  connections well past Node's 5 s default so the server never closes one
   *  mid-reuse (→ `write EPIPE`). `headersTimeout` stays larger. */
  servers: { name: 'api', type: 'express', json: { limit: '32mb' }, keepAliveTimeout: 60_000, headersTimeout: 70_000 },
});
