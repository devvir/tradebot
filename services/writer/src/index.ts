import { type MongoClient, type Service, type ExpressServerHandle } from '@devvir/service-kit';
import SK from './service';
import { buildRouter, startMetrics } from './server';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  await service.providers.connect([ 'mongodb' ]);

  const mongo = service.providers.get('mongodb') as MongoClient;
  const db    = mongo.db(config.database);

  const { counter, stop } = startMetrics();

  service.on('shutdown', stop);

  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter(db, config, counter));

  await api.start();
});
