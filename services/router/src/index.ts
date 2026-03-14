import SK from './service';
import type { RabbitMQ } from '@devvir/service-kit';
import { startConsuming } from './routing';
import type { Route } from './types';

SK.run(async (service) => {
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  await startConsuming(broker, service.config('routes') as Route[]);
});
