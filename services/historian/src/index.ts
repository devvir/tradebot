import SK from './service.js';
import type { MongoClient } from '@devvir/service-kit';
import type { Config } from './types.js';
import { runAllTables } from './runner.js';
import { createPersistenceService, verifyFirstTimestamps } from './persistence/index.js';
import { fetchSymbols } from './utils/symbols.js';

SK.run(async (service) => {
  const config = service.config() as Config;
  const mongo = await service.providers.connect('mongodb') as MongoClient;
  const db = mongo.db(config.database);
  const persistence = createPersistenceService(db);

  const states = await persistence.loadAllStates();
  const { instruments, indices, inactive } = await fetchSymbols(config.bitmexRestUrl);

  await verifyFirstTimestamps({ baseUrl: config.bitmexRestUrl, states });
  await runAllTables(service, persistence, { states, instruments, indices, inactive });
});
