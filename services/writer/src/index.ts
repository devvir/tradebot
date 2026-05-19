import { type MongoClient, type Service } from '@devvir/service-kit';
import SK from './service';
import { startServer } from './server';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  await service.providers.connect([ 'mongodb' ]);

  const mongo = service.providers.get('mongodb') as MongoClient;
  const db    = mongo.db(config.database);

  const http = startServer(db, config);

  service.on('shutdown', () => http.close());
});
