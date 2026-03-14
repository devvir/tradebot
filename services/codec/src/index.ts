import SK, { QUEUE, OUTBOUND_EXCHANGE } from './service';
import { RabbitMQ } from '@devvir/service-kit';
import { transform } from './encoding';
import type { Message } from './types';

SK.run(async (service) => {
  const broker      = await service.providers.connect('rabbitmq') as RabbitMQ.Broker;
  const queue       = broker.getQueue(QUEUE)!;
  const outExchange = broker.getExchange(OUTBOUND_EXCHANGE)!;

  service.logger.info('Started message consumption');

  const stopConsuming = await queue.consume(async (message, { ack, nack, original }) => {
    try {
      await outExchange.republish({ ...original, content: transform(original, message as Message) });

      ack();
      service.emit('message');
    } catch (err) {
      nack(true);

      const errorPayload = { err, message: (message as string).slice(0, 200) };
      service.logger.error(errorPayload, 'Failed to process message');
    }
  }, { prefetch: service.config('prefetch') as number });

  service.once('shutdown', () => stopConsuming?.());
});
