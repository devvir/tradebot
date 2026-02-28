import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connectToQueue } from './rabbitmq';
import { startConsuming } from './routing';
import service from './service';

service.run(async () => {
  logger.info('Starting Router Service...');

  const config = loadConfig();
  const broker = await connectToQueue(config);

  await startConsuming(broker, config.routes);

  return { broker, routes: config.routes };
});
