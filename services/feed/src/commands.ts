import type { Channel } from 'amqplib';
import type { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import logger from './logger';
import { filterChannelsByRole, type Config } from './config';
import { subscribeToTopics, unsubscribeFromTopics } from './subscriptions';

interface CommandMessage {
  command: 'subscribe' | 'unsubscribe' | 'resubscribe';
  channel: string | string[];
}

interface FeedState {
  ws: WebSocket | null;
}

/**
 * Set up command listener for dynamic subscription management
 */
export const setupCommandListener = async (
  rabbitChannel: Channel,
  state: FeedState,
  subscriptionEvents: EventEmitter,
  config: Config
): Promise<void> => {
  const exchangeName = 'feed-commands';

  await rabbitChannel.assertExchange(exchangeName, 'fanout', { durable: true });

  const { queue } = await rabbitChannel.assertQueue('', { exclusive: true });
  await rabbitChannel.bindQueue(queue, exchangeName, '');

  logger.info({ exchange: exchangeName, queue }, 'Listening for subscription commands');

  rabbitChannel.consume(queue, msg => {
    if (! msg) return;

    try {
      const command: CommandMessage = JSON.parse(msg.content.toString());
      handleCommand(command, state, subscriptionEvents, config);
    } catch (error) {
      logger.error({ error }, 'Failed to process command');
    }
  }, { noAck: true });
};

/**
 * Process a subscription command
 */
const handleCommand = (
  command: CommandMessage,
  state: FeedState,
  subscriptionEvents: EventEmitter,
  config: Config
): void => {
  if (! state.ws || state.ws.readyState !== 1) {
    logger.debug({ command: command.command }, 'Ignoring command - WebSocket not connected');
    return;
  }

  const channels = Array.isArray(command.channel) ? command.channel : [command.channel];

  const allowedChannels = filterChannelsByRole(channels, config.role);

  if (allowedChannels.length === 0) {
    return;
  }

  logger.info({ command: command.command, channels: allowedChannels }, 'Processing command');

  const ws = state.ws;

  switch (command.command) {
    case 'subscribe':
      subscribeToTopics(ws, allowedChannels, config.batchSizeChannels, config.batchDelayMs);
      break;
    case 'unsubscribe':
      unsubscribeFromTopics(ws, allowedChannels, config.batchSizeChannels, config.batchDelayMs);
      break;
    case 'resubscribe':
      resubscribe(ws, allowedChannels, subscriptionEvents, config.batchSizeChannels, config.batchDelayMs);
      break;
  }
};

/**
 * Resubscribe - unsubscribe then subscribe after all confirmations received
 */
const resubscribe = (
  ws: WebSocket,
  channels: string[],
  subscriptionEvents: EventEmitter,
  batchSize: number,
  batchDelay: number
): void => {
  const pendingUnsubscribes = new Set(channels);
  const TIMEOUT_MS = 10000; // 10 second timeout for all confirmations

  const onUnsubscribed = (channel: string): void => {
    pendingUnsubscribes.delete(channel);

    if (pendingUnsubscribes.size === 0) {
      cleanup();
      logger.info({ channels }, 'All unsubscribes confirmed, resubscribing');
      subscribeToTopics(ws, channels, batchSize, batchDelay);
    }
  };

  const onTimeout = (): void => {
    cleanup();
    if (pendingUnsubscribes.size > 0) {
      logger.warn(
        { pending: Array.from(pendingUnsubscribes), channels },
        'Resubscribe timeout - some unsubscribe confirmations not received, proceeding anyway'
      );
    }
    subscribeToTopics(ws, channels, batchSize, batchDelay);
  };

  const cleanup = (): void => {
    subscriptionEvents.off('unsubscribed', onUnsubscribed);
    clearTimeout(timeoutHandle);
  };

  subscriptionEvents.on('unsubscribed', onUnsubscribed);
  const timeoutHandle = setTimeout(onTimeout, TIMEOUT_MS);

  unsubscribeFromTopics(ws, channels, batchSize, batchDelay);
};
