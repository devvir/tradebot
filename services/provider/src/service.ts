import { SKFactory } from '@tradebot/utils';
import config from './config';

export default SKFactory({
  name:    'provider',
  config,
  servers: { name: 'api', type: 'express' },
  clients: { name: 'librarian', url: config.librarianUrl },
});
