import { logger } from '@devvir/service';
import {
  type BitmexWebSocketMessage,
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
 * - Publishes all data messages to the feed exchange
 */
export const createMessageHandler = (state: FeedState): MessageHandler => (buffer: Buffer): void => {
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

    state.broker!.getExchange()!.publish(message, message.table, {
      headers: { api_version: state.apiVersion || undefined },
    });

    increaseCounter();
  } catch (error) {
    console.log({ error }, 'Error processing WebSocket message');
    logger.error({ err: error }, 'Error processing WebSocket message');
  }
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
}

let counter = 0;

const increaseCounter = () => {
  if (++counter % 10000 === 0) {
    logger.info(`Processed ${ Math.floor(counter / 1000) }k messages`);
  }
};
