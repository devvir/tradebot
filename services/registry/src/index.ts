import SK from './service.js';
import type { MongoClient } from '@devvir/service-kit';
import { bootstrap } from './store.js';
import { startServer } from './server/index.js';

SK.run(async (service) => {
  const mongo  = await service.providers.connect('mongodb') as MongoClient;
  const db     = mongo.db(service.config('database') as string);

  await bootstrap(db);

  const server = startServer(db);

  service.on('shutdown', () => server.close());
});
