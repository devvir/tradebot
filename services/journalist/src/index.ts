import { logger, type RabbitMQ, type Service } from '@devvir/service-kit';
import SK from './service';
import { Config, isBitmexDataMessage } from './types';
import { poolTable } from './route';
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
    const pool  = metadata.headers?.['x-bitmex-pool'] as string | undefined;
    const table = poolTable(message.table, pool);
    const day   = date.slice(0, 10).replace(/-/g, '');

    closer.track(table, day);

    await buffer.receive(table, day, { action, date, data }).catch(err =>
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
