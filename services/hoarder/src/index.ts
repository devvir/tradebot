import SK from './service';
import { logger, type RabbitMQ, type Service } from '@devvir/service-kit';
import { createMessageHandler } from './messages';
import { pauseAll, resumeAll } from './pool';
import { subscribe } from './subscriptions';
import { channelsFor } from './venues';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  broker.getExchange()!.setBackpressureHandler((paused) => {
    if (paused) pauseAll();
    else        resumeAll();
  });

  const onMessage = createMessageHandler(service, () => service.emit('message'));

  // Subscribe every configured venue's channels — connections are created on
  // demand, one per (venue, endpoint, socket key). A channel the venue refuses
  // is dropped; every other one is retried until it is confirmed.
  await Promise.all(config.venues.flatMap(venue =>
    channelsFor(venue).map(channel =>
      subscribe(venue, channel, service, onMessage)
        .catch(err => logger.error({ err, venue, channel }, 'Subscription failed')),
    ),
  ));
});
