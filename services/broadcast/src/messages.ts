import { logger } from '@devvir/service-kit';
import {
  type BitmexWebSocketMessage,
  type Config,
  type FeedState,
  isBitmexSubscriptionMessage,
  isBitmexUnsubscriptionMessage,
  isBitmexInfoMessage,
  isBitmexDataMessage,
  MessageHandler,
} from './types';

/**
 * Creates a message handler that publishes all BitMEX messages directly.
 * - Logs subscription/info control messages
 * - Publishes all data messages to the configured exchange
 */
export const createMessageHandler = (state: FeedState, config: Config, onMessage: () => void): MessageHandler => {
  return async (buffer: Buffer): Promise<void> => {
    state.lastMessageTime = Date.now();

    try {
      var message = JSON.parse(buffer.toString()) as BitmexWebSocketMessage;
    } catch (error) {
      return logger.error({ err: error }, 'Failed to parse WebSocket message');
    }

    try {
      if (! isBitmexDataMessage(message)) {
        return handleControlMessage(message, state);
      }

      const content = Buffer.from(JSON.stringify(message));
      const exchange = state.broker!.getExchange()!;

      const symbols = [ ...new Set(
        message.data?.map(item => 'symbol' in item ? item.symbol : '') ?? [].filter(Boolean))
      ];
      const symbol = symbols.length === 1 ? symbols[0] : '';
      const routingKey = `${message.table}.${message.action}.${symbol}`;

      await exchange.publish(content, routingKey, {
        contentType: 'application/json',
        headers: {
          'x-worker-uuid': config.workerUuid,
          'x-bitmex-version': state.apiVersion ?? '',
          'x-bitmex-symbols': symbols.join(','),
          'x-bitmex-published-at': new Date().toISOString(),
        },
      });

      onMessage();
    } catch (err) {
      logger.error({ err }, 'Error processing WebSocket message');
    }
  };
};

const handleControlMessage = (message: BitmexWebSocketMessage, state: FeedState): void => {
  if (isBitmexInfoMessage(message)) {
    state.apiVersion ??= message.version;
    logger.debug({ info: message.info, version: message.version }, 'Informative message received');
  } else if (isBitmexSubscriptionMessage(message)) {
    logger.debug({ subscribe: message.subscribe, success: message.success }, 'Subscription event');
  } else if (isBitmexUnsubscriptionMessage(message)) {
    logger.debug({ unsubscribe: message.unsubscribe, success: message.success }, 'Unsubscription event');
  } else {
    const msgPreview = JSON.stringify(message).slice(0, 200);
    logger.warn({ message: msgPreview }, 'Unrecognized message received');
  }
};
