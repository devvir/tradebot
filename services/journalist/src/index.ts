import { logger, type RabbitMQ, type Service } from '@devvir/service-kit';
import SK from './service';
import { Config, isBitmexDataMessage } from './types';
import { routeMessage, bucketDay, vaultTable } from './route';
import { createBuffer } from './persistence/buffer';
import { createCloser } from './persistence/closer';

SK.run(async (service: Service) => {
  const { vaultUrl, vaultSuffix } = service.config() as Config;

  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const buffer = createBuffer(vaultUrl, vaultSuffix);
  const closer = createCloser(vaultUrl, vaultSuffix, buffer.flushAll);

  const stop = await broker.getQueue()!.consume(async (message, { ack, metadata }) => {
    if (! isBitmexDataMessage(message))
      return logger.warn('Ignoring non-data message');

    const date = metadata.headers?.['x-bitmex-published-at'] as string | undefined;

    if (! date) {
      const payload = { table: message.table, action: message.action, data: message.data[0] ?? '[]' };
      logger.error(payload, 'Message dropped — missing x-bitmex-published-at header');
      return ack();
    }

    const { data, action } = message;

    for (const group of routeMessage(message.table, data)) {
      const table = vaultTable(group.table, group.data);
      const day   = bucketDay(group.data, date);

      closer.track(table, day);

      await buffer.receive(table, day, { action, date, data: group.data }).catch(err =>
        logger.error({ err, table, action }, 'Unexpected error processing message — dropping'),
      );
    }

    ack();
    service.emit('message');
  }, { prefetch: 100 });

  service.on('shutdown', async () => {
    stop?.();
    await buffer.flushAll();
  });
});
