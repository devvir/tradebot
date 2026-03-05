import service from './service';
import { loadConfig } from './config';
import { connectToDatabase } from './mongodb';
import { connectToQueue, startConsuming } from './rabbitmq';

service.run(async () => {
  const config = loadConfig();

  const [mongo, broker] = await Promise.all([
    connectToDatabase(config.mongodbUrl),
    connectToQueue(config.rabbitmqUrl),
  ]);

  const drain = await startConsuming(broker, mongo, config, service.onMessage);

  return { mongo, broker, drain };
});
