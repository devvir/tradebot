import { Broker, logger, Service } from '@devvir/service-kit';
import {
  type BitmexWebSocketMessage,
  type Config,
  type State,
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
export const createMessageHandler = (service: Service, onMessage: () => void): MessageHandler => {
  const state = service.state() as State;
  const config = service.config() as Config;
  const broker = service.providers.get('rabbitmq') as Broker;

  let messageCount = 0;

  return async (buffer: Buffer, accountId?: string, pool?: string): Promise<void> => {
    service.setState('lastMessageTime', Date.now());

    try {
      var message = JSON.parse(buffer.toString()) as BitmexWebSocketMessage;
    } catch (error) {
      return logger.error({ err: error }, 'Failed to parse WebSocket message');
    }

    try {
      if (! isBitmexDataMessage(message))
        return handleControlMessage(message, state);

      const exchange = broker.getExchange()!;
      const content = Buffer.from(JSON.stringify(message));
      const routingKey = `${message.table}.${message.action}`;

      await exchange.publish(content, routingKey, {
        contentType: 'application/json',
        headers: {
          'x-worker-uuid': config.workerUuid,
          'x-message-count': String(++messageCount),
          'x-bitmex-version': state.apiVersion ?? '',
          'x-bitmex-published-at': new Date().toISOString(),
          'x-account-id': accountId ?? '',
          'x-bitmex-pool': pool ?? '',
        },
      });

      onMessage();
    } catch (err) {
      if (err instanceof Error && err.message === 'Channel closed')
        throw err;

      logger.error({ err }, 'Error processing WebSocket message');
    }
  };
};

const handleControlMessage = (message: BitmexWebSocketMessage, state: State): void => {
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
