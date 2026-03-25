import type { MongoClient } from 'mongodb';
import type { Broker, Config, ConsumerEvent } from './types';
import SK, { QUEUE } from './service';
import createManager from './manager';
import { greenLight, pause } from './semaphore';

SK.run(async (service) => {
  const [ mongo, broker ] = await service.providers.connect([
    'mongodb',
    'rabbitmq',
  ]) as [ MongoClient, Broker ];

  const manager = createManager(service.config() as Config, mongo);
  const prefetch = service.config('prefetch') as number;
  const queue = broker.getQueue(QUEUE)!;

  /** Start processing documents */
  manager.process();

  /** Start consuming messages from RabbitMQ, and enqueue them for processing */
  const stopConsuming = await queue.consume(async (message: unknown, delivery: ConsumerEvent) => {
    await greenLight();

    const confirm = () => { delivery.ack(); service.emit('message'); };

    await manager!.enqueue(message, { ...delivery, ack: confirm });
  }, { prefetch });

  service.on('shutdown', async () => {
    pause();

    if (stopConsuming) await stopConsuming();
    if (manager) await manager.flushAll();
  });
});
