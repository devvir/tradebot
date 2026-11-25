import SK from './service';
import { RabbitMQ } from '@devvir/service-kit';
import type { Service } from '@devvir/service-kit';
import type { Config } from './types';
import { declareConsumerTopology, declarePublisherTopology } from './topology';
import { createBackpressureGate } from './backpressure';
import { consumeAndRepublish } from './consumer';
import { connectConsumer, exitOnConsumerLoss, answerHealthCheck, stopOnShutdown } from './lifecycle';

SK.run(async (service: Service) => {
  const config    = service.config() as Config;
  const consumer  = await connectConsumer(config.rabbitmqUrl);
  const publisher = await RabbitMQ.keepAlive(config.rabbitmqUrl);

  // The publisher reconnects indefinitely (keepAlive), so only the consumer ends the process;
  // while the publisher is down the health check answers 503.
  exitOnConsumerLoss(consumer);
  answerHealthCheck(service, consumer, publisher);

  await declareConsumerTopology(consumer, config);
  await declarePublisherTopology(publisher, config);

  const backpressure = await createBackpressureGate(consumer, config);
  const routing      = await consumeAndRepublish(consumer, publisher, config, backpressure);

  stopOnShutdown(service, { consumer, publisher, routing, backpressure });
});
