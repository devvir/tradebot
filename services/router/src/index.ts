import SK from './service';
import type { RabbitMQ, Service } from '@devvir/service-kit';
import type { Config } from './types';
import { declareTopology } from './topology';
import { createBackpressureGate } from './backpressure';
import { consumeAndRepublish } from './consumer';

SK.run(async (service: Service) => {
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const config = service.config() as Config;

  await declareTopology(broker, config);

  const holdPublishing = createBackpressureGate(broker, config);

  await consumeAndRepublish(broker, config, holdPublishing);
});
