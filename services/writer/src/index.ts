import { loadConfig } from './config';
import { connectToDatabase, startConsuming } from './persistence';
import { connectToQueue } from './rabbitmq';
import service from './service';

service.run(async () => {
  const config = loadConfig();

  const [mongo, broker] = await Promise.all([
    connectToDatabase(config.mongodbUrl, config.database),
    connectToQueue(config),
  ]);

  const channel = broker.getChannel();
  if (! channel) throw new Error('Failed to get channel from broker');

  await startConsuming(channel, mongo.db, config, service.onMessage);

  return { mongo, broker };
});
