import SK from './service';
import type { RabbitMQ } from '@devvir/service-kit';

/**
 * Declare the configured exchanges and bindings, then exit: with 0 once they are declared, and
 * with 1 when the broker cannot be reached or rejects a declaration.
 */
SK.run(async (service) => {
  try {
    const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

    await broker.declares(service.config('topology') as RabbitMQ.TopologySpec);
  } catch (err) {
    service.logger.error({ err }, 'Failed to declare bindings');
    process.exit(1);
  }

  service.logger.info('Bindings successfully declared — exiting');

  await service.shutdown();
});
