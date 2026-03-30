import { RabbitMQ, type Service } from '@devvir/service-kit';
import SK from './service';
import { reconstruct } from './reconstruct';
import type { Broker, Config, WsMessage } from './types';
import { BitmexTable } from '@tradebot/types';

type ConsumerEvent = RabbitMQ.ConsumerEvent;

SK.run(async (service: Service) => {
  const config = service.config() as Config;

  const [ consumer, publisher ] = await service.providers.connect([
    'consumer',
    'publisher',
  ]) as [ Broker, Broker ];

  const inQueue     = consumer.getQueue()!;
  const outExchange = publisher.getExchange()!;

  const stopConsuming = await inQueue.consume(async (message: unknown, { ack, nack, metadata }: ConsumerEvent) => {
    const table    = metadata.headers?.['x-table'] as BitmexTable | undefined;
    const date     = metadata.headers?.['x-date']  as string | undefined;
    const msgIndex = metadata.headers?.['x-msg-index'] as number | undefined;

    if (! table || ! date || msgIndex === undefined) {
      service.logger.warn({ headers: metadata.headers }, 'Message missing required headers — discarding');
      return ack();
    }

    try {
      const wsMessage = message as WsMessage;
      const reconstructed = reconstruct(table, wsMessage);

      if (reconstructed === null)
        return ack();

      await outExchange.publish(reconstructed, 'record', {
        headers: {
          'x-table':     table,
          'x-date':      date,
          'x-msg-index': msgIndex,
        },
      });

      ack();
      service.emit('message');
    } catch (err) {
      service.logger.error({ err, table, date, msgIndex }, 'Failed to reconstruct message');
      nack(true);
    }
  }, { prefetch: config.prefetch });

  service.once('shutdown', () => stopConsuming?.());
});
