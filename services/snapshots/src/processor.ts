import { type RabbitMQ, type Broker, type Service, logger } from '@devvir/service-kit';
import type { BitmexMessage, Database } from '@devvir/bitmex-database';

export const startDeltaConsumer = async (service: Service): Promise<() => Promise<void>> => {
  const broker = service.providers.get('rabbitmq') as Broker;
  const queue = broker.getQueue()!;

  return queue.consume((message: unknown, { ack, metadata }: RabbitMQ.ConsumerEvent) => {
    const counter = Number(metadata.headers?.['x-message-count']) || 0;

    ack();

    service.emit('message');

    const msg = message as BitmexMessage & { filter?: Record<string, unknown> };
    const db = service.state('database') as Database;
    const counters = service.state('counters') as Record<string, number>;
    const tables = service.state('tables') as Set<string>;

    /** Drop pre-filtered partials (snapshots are unfiltered, table-based only) */
    if (msg.action === 'partial' && msg.filter && 'symbol' in msg.filter) {
      return logger.error(
        { table: msg.table, filter: msg.filter },
        'Received pre-filtered partial (not supported)'
      );
    }

    db.apply(msg);

    counters[msg.table] = counter;

    if (msg.action === 'partial') {
      tables.add(msg.table);
    }
  }, { prefetch: 1000 });
};
