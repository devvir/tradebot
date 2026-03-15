import { type RabbitMQ, type Broker, type Service, logger } from '@devvir/service-kit';
import type { BitmexMessage, Message, Snapshot, State } from './types';
import { applyDelta, newSnapshot } from './accumulator';

export const startDeltaConsumer = async (service: Service): Promise<() => Promise<void>> => {
  const broker = service.providers.get('rabbitmq') as Broker;
  const queue  = broker.getQueue()!;

  return queue.consume((message: unknown, { ack, metadata }: RabbitMQ.ConsumerEvent) => {
    const counter = Number(metadata.headers?.['x-message-count']) || 0;
    const msg = Object.assign(message as BitmexMessage, { counter }) as Message;

    ack();

    service.emit('message');

    const snapshots = service.state('snapshots') as State['snapshots'];
    const snapshot  = snapshots[msg.table] as Snapshot | undefined;

    /** Drop pre-filtered partials (snapshots are unfiltered, table-based only) */
    if (msg.action === 'partial' && 'filter' in msg && 'symbol' in msg.filter!) {
      const errorPayload = { table: msg.table, filter: msg.filter };
      return logger.error(errorPayload, 'Received pre-filtered partial (not supported)');
    }

    /** Drop deltas until we have initialized the table snapshot */
    if (! snapshot && msg.action !== 'partial') {
      const debugPayload = { table: msg.table, action: msg.action };
      return service.logger.debug(debugPayload, 'Discarding delta: no partial yet');
    }

    /** Initialize or refresh the table snapshot */
    if (msg.action === 'partial')
      snapshots[msg.table] = newSnapshot(msg);

    /** Apply deltas to existing table snapshot */
    else if (snapshot)
      applyDelta(snapshot, msg);
  }, { prefetch: 1000 });
};
