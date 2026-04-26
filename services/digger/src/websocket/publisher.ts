import { logger, type Broker } from '@devvir/service-kit';
import type { Config, OutboundMessage, WsMessage } from '../types';

/**
 * Publishes WS-format messages to the `replay` topic exchange. Mirrors
 * broadcast's output exactly (routing key pattern, content-type, headers)
 * so downstream consumers can swap between live and replay modes.
 *
 * Backpressure: when `config.waitIfQueues` is set, exchange.publish() pauses
 * automatically until the watched queues drop below their depth limits.
 */

/**
 * BitMEX WS API version this replay stream is shaped for. Hardcoded because
 * the historical data we read was captured under this version. If BitMEX bumps
 * the wire format, the stored data — and this constant — will need migration.
 */
const BITMEX_API_VERSION = '2.0.0';

let messageCount = 0;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Publish one outbound stream message.
 * Routing key: `<table>.<action>` (e.g. "trade.insert").
 */
export const publish = async (
  msg:    OutboundMessage,
  broker: Broker,
  config: Config,
): Promise<void> => {
  const exchange = broker.getExchange();

  if (! exchange) {
    logger.warn({ table: msg.table }, 'Exchange not available — message dropped');
    return;
  }

  try {
    await exchange.publish(
      Buffer.from(JSON.stringify(msg.payload)),
      `${msg.table}.${msg.action}`,
      {
        contentType: 'application/json',
        waitIf:      config.waitIfQueues,
        headers: {
          'x-worker-uuid':         config.workerUuid,
          'x-message-count':       String(++messageCount),
          'x-bitmex-version':      BITMEX_API_VERSION,
          'x-bitmex-published-at': new Date().toISOString(),
        },
      },
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'Channel closed') throw err;

    logger.error({ err, table: msg.table, action: msg.action }, 'Failed to publish message');
  }
};

/**
 * Publish a `partial` (schema + snapshot) message at subscribe time.
 * Sent before the stream starts so consumers always receive schema and current
 * state before any deltas arrive.
 */
export const publishPartial = async (
  partial: WsMessage,
  broker:  Broker,
  config:  Config,
): Promise<void> => {
  const exchange = broker.getExchange();

  if (! exchange) {
    logger.warn({ table: partial.table }, 'Exchange not available — partial not sent');
    return;
  }

  await exchange.publish(
    Buffer.from(JSON.stringify(partial)),
    `${partial.table}.partial`,
    {
      contentType: 'application/json',
      waitIf:      config.waitIfQueues,
      headers: {
        'x-worker-uuid':         config.workerUuid,
        'x-message-count':       String(++messageCount),
        'x-bitmex-version':      BITMEX_API_VERSION,
        'x-bitmex-published-at': new Date().toISOString(),
      },
    },
  );
};
