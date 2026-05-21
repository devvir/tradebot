import SK from './service.js';
import type { MongoClient, ExpressServerHandle } from '@devvir/service-kit';
import { bootstrap } from './store.js';
import { buildRouter } from './server/routes.js';

SK.run(async (service) => {
  const mongo = await service.providers.connect('mongodb') as MongoClient;
  const db    = mongo.db(service.config('database') as string);

  await bootstrap(db);

  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter(db));

  await api.start();
});
