import SK from './service';
import type { RabbitMQ, Service } from '@devvir/service-kit';
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
  // demand, one per (venue, endpoint, socket key).
  await Promise.all(config.venues.flatMap(venue =>
    channelsFor(venue).map(channel =>
      subscribe(venue, channel, service, onMessage).catch(err => service.emit('failure', err)),
    ),
  ));
});
