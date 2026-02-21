import { loadConfig } from './config';
import { connectMongoWithRetry, startConsuming } from './persistence';
import { connectToQueue } from './rabbitmq';
import service from './service';

service.run(async () => {
  const config = loadConfig();

  const [mongo, broker] = await Promise.all([
    connectMongoWithRetry(config.mongodbUrl),
    connectToQueue(config.rabbitmqUrl),
  ]);

  const channel = broker.getChannel();
  if (! channel) throw new Error('Failed to get channel from broker');

  await startConsuming(channel, mongo.db, config.batchSize, service.onMessage);

  return { mongo, broker };
});
