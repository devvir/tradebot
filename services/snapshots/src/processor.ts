import { type RabbitMQ, type Broker, type Service, logger } from '@devvir/service-kit';
import type { BitmexMessage, Database } from '@devvir/bitmex-database';
import { PRIVATE_TABLES, applyPrivateDelta } from './private';

export const startDeltaConsumer = async (service: Service): Promise<() => Promise<void>> => {
  const broker = service.providers.get('rabbitmq') as Broker;
  const queue  = broker.getQueue()!;

  return queue.consume((message: unknown, { ack, metadata }: RabbitMQ.ConsumerEvent) => {
    const counter = Number(metadata.headers?.['x-message-count']) || 0;

    ack();

    service.emit('message');

    const msg = message as BitmexMessage & { filter?: Record<string, unknown> };

    if (! PRIVATE_TABLES.has(msg.table))
      return applyPublicDelta(service, msg, counter);

    const accountId = metadata.headers?.['x-account-id'] as string | undefined;

    if (! accountId)
      return logger.error({ table: msg.table }, 'Private table message missing x-account-id header — dropping');

    applyPrivateDelta(service, msg, accountId, counter);
  }, { prefetch: 1000 });
};

const applyPublicDelta = (
  service: Service,
  msg:     BitmexMessage & { filter?: Record<string, unknown> },
  counter: number,
): void => {
  if (msg.action === 'partial' && msg.filter && 'symbol' in msg.filter) {
    return logger.error(
      { table: msg.table, filter: msg.filter },
      'Received pre-filtered partial (not supported)'
    );
  }

  const db       = service.state('database')  as Database;
  const counters = service.state('counters')   as Record<string, number>;
  const tables   = service.state('tables')     as Set<string>;

  db.apply(msg);

  counters[msg.table] = counter;

  if (msg.action === 'partial') {
    tables.add(msg.table);
  }
};
