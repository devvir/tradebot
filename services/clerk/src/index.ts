import type { RedisClient } from '@devvir/service-kit';
import SK from './service';
import { runLoop } from './loop';
import { createBackpressureGate } from './backpressure';
import type { Broker, Config } from './types';

SK.run(async (service) => {
  const config            = service.config() as Config;
  const [ redis, broker ] = await service.providers.connect([
    'redis',
    'rabbitmq',
  ]) as [ RedisClient, Broker ];

  const gate       = createBackpressureGate(broker, config.watchQueues, config.maxReady);
  const stopSignal = { stopped: false };

  await runLoop(config, broker, redis, gate, stopSignal);

  service.on('shutdown', () => { stopSignal.stopped = true; });
});
