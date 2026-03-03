import { logger } from '@devvir/service';
import { loadConfig } from './config';
import { connect } from './rabbitmq';

const main = async () => {
  const config = loadConfig();
  const broker = await connect(config);
  await broker.close();

  logger.info('Bindings successfully declared — exiting');
};

main().catch((error) => {
  logger.error({ err: error }, 'Failed to declare pipe bindings');

  process.exit(1);
});
