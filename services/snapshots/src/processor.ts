import { type RabbitMQ, type Broker, type Service, logger } from '@devvir/service-kit';
import type { BitmexMessage, Database, PartialMessage } from '@devvir/bitmex-database';

export const startDeltaConsumer = async (service: Service): Promise<() => Promise<void>> => {
  const broker = service.providers.get('rabbitmq') as Broker;
  const queue  = broker.getQueue()!;

  return queue.consume((message: unknown, { ack, metadata }: RabbitMQ.ConsumerEvent) => {
    const wsMessage = message as BitmexMessage | PartialMessage;
    const counter = Number(metadata.headers?.['x-message-count']) || 0;

    ack();

    service.emit('message');

    if ('filter' in wsMessage && 'symbol' in wsMessage.filter!) {
      const payload = { table: wsMessage.table, filter: wsMessage.filter };
      return logger.error(payload, 'Received pre-filtered partial (not supported)');
    }

    applyDelta(service, wsMessage, counter);
  }, { prefetch: 1000 });
};

const applyDelta = (
  service: Service,
  msg:     BitmexMessage,
  counter: number,
): void => {
  const db       = service.state('database') as Database;
  const counters = service.state('counters') as Record<string, number>;
  const tables   = service.state('tables')   as Set<string>;

  db.apply(msg, true);

  counters[msg.table] = counter;

  if (msg.action === 'partial') {
    tables.add(msg.table);
  }
};
