import SK from './service.js';
import type { MongoClient } from '@devvir/service-kit';
import type { Config } from './types.js';
import { bootstrap } from './store.js';
import { startServer } from './server/index.js';

SK.run(async (service) => {
  const config = service.config() as Config;
  const mongo  = await service.providers.connect('mongodb') as MongoClient;
  const db     = mongo.db(config.database);

  await bootstrap(db);

  const server = startServer(db, config);

  service.on('shutdown', () => server.close());
});
