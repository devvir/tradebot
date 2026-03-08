import service from './service';
import { loadConfig } from './config';
import { connectToDatabase } from './mongodb';
import { connectToQueue, QUEUE } from './rabbitmq';
import createManager from './manager';
import { ConsumerEvent } from '@devvir/rabbitmq';
import { greenLight, pause } from './semaphore';

service.run(async () => {
  const config = loadConfig();

  const [mongo, broker] = await Promise.all([
    connectToDatabase(config.mongodbUrl),
    connectToQueue(config.rabbitmqUrl),
  ]);

  const manager = createManager(config, mongo);
  const queue = await broker.getQueue(QUEUE)!;

  /**
   * Start processing documents
   */
  manager.process();

  /**
   * Start consuming messages from RabbitMQ, and enqueue them for processing.
   */
  const stopConsuming = await queue.consume(async (message: unknown, delivery: ConsumerEvent) => {
    await greenLight();

    const confirm = () => (delivery.ack(), service.onMessage());

    await manager.enqueue(message, { ...delivery, ack: confirm });
  }, { prefetch: config.prefetch });

  /**
   * On shutdown, stop consuming messages and flush pending batches before exiting.
   */
  const onShutdown = async (): Promise<void> => {
    pause();

    await stopConsuming();
    await manager.flushAll();
  }

  return { mongo, broker, onShutdown };
});
