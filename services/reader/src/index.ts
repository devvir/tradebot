import SK from './service';
import type { MongoClient } from 'mongodb';
import type { RabbitMQ } from '@devvir/service-kit';
import { loadPollingState, startPeriodicStateSave } from './state';
import { runPollingLoop } from './poller';
import { createPublisher } from './publisher';
import type { Config } from './types';

SK.run(async (service) => {
  const config = service.config() as Config;
  const [mongo, broker] = await service.providers.connect(['mongodb', 'rabbitmq']) as [MongoClient, RabbitMQ.Broker];

  const db = mongo.db(config.database);

  await broker.declares({ queues: { [`reader.${config.database}`]: {} } });

  await loadPollingState(db);
  await startPeriodicStateSave(db);

  const publish = createPublisher(broker, config);

  runPollingLoop(db, config, async (collection, doc) => {
    await publish(collection, doc);
    service.increment('messagesPublished');
    service.setState('lastPublishedAt', Date.now());
  });
});
