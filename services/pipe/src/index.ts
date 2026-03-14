import SK from './service';
import type { RabbitMQ } from '@devvir/service-kit';

SK.run(async (service) => {
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  await broker.declares(service.config('topology') as RabbitMQ.TopologySpec);

  service.logger.info('Bindings successfully declared — exiting');

  service.shutdown();
});
