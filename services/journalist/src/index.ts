import { logger, type RabbitMQ, type Service } from '@devvir/service-kit';
import SK from './service';
import { isBitmexDataMessage } from './types';
import { createBuffer } from './persistence/buffer';

SK.run(async (service: Service) => {
  const broker = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const buffer = createBuffer(service.config('vaultUrl') as string);

  const stop = await broker.getQueue()!.consume(async (message, { ack, metadata }) => {
    if (! isBitmexDataMessage(message))
      return logger.warn('Ignoring non-data message');

    const date = metadata.headers?.['x-bitmex-published-at'] as string | undefined;

    if (! date) {
      const payload = { table: message.table, action: message.action, data: message.data[0] ?? '[]' };
      logger.error(payload, 'Message dropped — missing x-bitmex-published-at header');
      return ack();
    }

    const { data, action, table } = message;

    await buffer.receive(table, { action, date, data }).catch(err =>
      logger.error({ err, table, action }, 'Unexpected error processing message — dropping'),
    );

    ack();
    service.emit('message');
  }, { prefetch: 100 });

  service.on('shutdown', async () => {
    stop?.();
    await buffer.flushAll();
  });
});
