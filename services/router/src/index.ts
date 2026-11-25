import SK from './service';
import { RabbitMQ } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import type { Config } from './types';
import { declareConsumerTopology, declarePublisherTopology } from './topology';
import { createBackpressureGate } from './backpressure';
import { consumeAndRepublish } from './consumer';
import { exitOnBrokerLoss, answerHealthCheck } from './lifecycle';

SK.run(async (service: Service) => {
  const consumer  = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const publisher = await RabbitMQ.keepAlive(process.env.QUEUE_URL!);
  const config    = service.config() as Config;

  exitOnBrokerLoss(consumer, publisher);
  answerHealthCheck(service, consumer, publisher);

  await declareConsumerTopology(consumer, config);
  await declarePublisherTopology(publisher, config);

  const backpressure = await createBackpressureGate(consumer, config);

  if (backpressure) service.on('shutdown', backpressure.stop);

  await consumeAndRepublish(consumer, publisher, config, backpressure?.hold ?? null);
});
