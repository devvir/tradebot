import { type MongoClient, type Service, type ExpressServerHandle } from '@devvir/service-kit';
import SK from './service';
import { buildRouter } from './server';
import { makeDbResolver } from './db';
import { startMetrics } from './metrics';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  await service.providers.connect([ 'mongodb' ]);

  const mongo = service.providers.get('mongodb') as MongoClient;
  const dbFor = makeDbResolver(mongo, config.database);

  const { writeCounter, readCounter, stop } = startMetrics();

  service.on('shutdown', stop);

  const api = service.servers.get('api') as ExpressServerHandle;

  api.addRoutes(buildRouter(dbFor, config, writeCounter, readCounter));

  await api.start();
});
