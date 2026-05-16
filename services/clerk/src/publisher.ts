// Publishing concerns for clerk.
//
// Owns the routing key decision, the per-file publish loop, and the control
// message sent when a file is fully published.

import { logger } from '@devvir/service-kit';
import { recordPublish } from './metrics';
import type { Broker, BufferItem, BoundedBuffer, ControlMessage } from './types';

const CONTROL_RETRY_DELAY_MS = 5_000;

/**
 * BitMEX tables whose vault files store reconstructed WS messages (envelope
 * with `action` + `data[]`). Everything else stores per-record REST data.
 */
const WS_TABLES = new Set<string>([
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
]);

/** Returns the routing key used for messages of a given table. */
export const routingKeyForTable = (table: string): string =>
  WS_TABLES.has(table) ? 'message' : 'record';

/**
 * Pops raw NDJSON lines from the buffer in order and publishes each as-is
 * (no parsing, no re-stringification) to RabbitMQ. Awaits each publish so
 * channel-level backpressure throttles this worker instead of letting unbounded
 * promises accumulate in the heap. Queue-depth backpressure is applied via the
 * exchange's shared `BackpressureGuard` (installed at startup) — no per-call
 * `waitIf` needed.
 */
export const publishTask = async (
  broker: Broker,
  table:  string,
  date:   string,
  buffer: BoundedBuffer<BufferItem>,
): Promise<void> => {
  const outExchange = broker.getExchange()!;
  const routingKey  = routingKeyForTable(table);

  while (true) {
    const next = await buffer.pop();

    if (! next) break;

    const { line, msgIndex } = next;

    await outExchange.publish(Buffer.from(line), routingKey, {
      headers: {
        'x-table':     table,
        'x-date':      date,
        'x-msg-index': msgIndex,
      },
    });

    recordPublish();
  }
};

/**
 * Publishes the bucket's `complete` control message with infinite retry.
 *
 * Why infinite: by the time we reach this, every data message in the file
 * has been published — possibly hours of work for a large orderBookL2 bucket.
 * Letting a transient publish failure abort the file would cause the entire
 * file to be re-processed next cycle. Retrying forever is the only sane
 * option; the loop body is one tiny message, so the cost is negligible.
 */
export const publishControl = async (
  broker:       Broker,
  table:        string,
  date:         string,
  highestIndex: number,
): Promise<void> => {
  const outExchange = broker.getExchange()!;
  const message: ControlMessage = { type: 'complete', table, date, highestIndex };

  let attempt = 0;

  while (true) {
    try {
      await outExchange.publish(message, 'control');

      logger.info({ table, date, highestIndex }, 'Control message published');

      return;
    } catch (err) {
      attempt++;

      logger.warn({ err, table, date, attempt }, 'Control publish failed — retrying');

      await new Promise(r => setTimeout(r, CONTROL_RETRY_DELAY_MS));
    }
  }
};
