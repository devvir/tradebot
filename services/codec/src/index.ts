import SK from './service';
import { RabbitMQ, Service } from '@devvir/service-kit';
import { transform } from './encoding';
import type { Message } from './types';

SK.run(async (service: Service) => {
  const [ consumer, publisher ] = await service.providers.connect([
    'consumer',
    'publisher',
  ]) as [ RabbitMQ.Broker, RabbitMQ.Broker ];

  const inQueue     = consumer.getQueue()!;
  const outExchange = publisher.getExchange()!;

  service.logger.info('Started message consumption');

  const stopConsuming = await inQueue.consume(async (message, { ack, nack, original }) => {
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
