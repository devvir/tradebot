import SK from './service';
import { RabbitMQ } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import type { Config } from './types';
import { declareConsumerTopology, declarePublisherTopology } from './topology';
import { createBackpressureGate } from './backpressure';
import { consumeAndRepublish } from './consumer';

SK.run(async (service: Service) => {
  const consumer  = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const publisher = await RabbitMQ.keepAlive(process.env.QUEUE_URL!);
  const config          = service.config() as Config;

  await declareConsumerTopology(consumer, config);
  await declarePublisherTopology(publisher, config);

  const holdPublishing = createBackpressureGate(consumer, config);

  await consumeAndRepublish(consumer, publisher, config, holdPublishing);
});
