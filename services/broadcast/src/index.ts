import SK from './service';
import type { RabbitMQ, Service } from '@devvir/service-kit';
import { createMessageHandler } from './messages';
import { pauseAll, resumeAll } from './pool';
import { subscribe, unsubscribe, startCommandServer } from './commands';
import type { Config } from './types';

SK.run(async (service: Service) => {
  const config = service.config() as Config;
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;

  broker.getExchange()!.setBackpressureHandler((paused) => {
    if (paused) pauseAll();
    else        resumeAll();
  });

  const onMessage = createMessageHandler(service, () => service.emit('message'));

  // Subscribe to preset channels — creates guest connections on demand
  await Promise.all(config.channels.map(ch =>
    subscribe(ch, service, onMessage).catch(err => service.emit('failure', err)),
  ));

  // HTTP command interface for runtime subscriptions
  startCommandServer(
    (channel, accountId) => subscribe(channel, service, onMessage, accountId),
    (channel, accountId) => unsubscribe(channel, accountId),
  );
});
