import WebSocket from 'ws';
import { logger } from '@devvir/service';

/**
 * Subscribe to a list of BitMEX channels in a single message.
 * Channels are plain names (e.g., 'trade'), no symbol suffix.
 */
export const subscribeToTopics = (ws: WebSocket, channels: readonly string[]): void => {
  if (channels.length === 0) return;
  logger.info({ channels }, 'Subscribing to channels');
  ws.send(JSON.stringify({ op: 'subscribe', args: channels }));
};

/**
 * Unsubscribe from a list of BitMEX channels in a single message.
 */
export const unsubscribeFromTopics = (ws: WebSocket, channels: string[]): void => {
  if (channels.length === 0) return;
  logger.info({ channels }, 'Unsubscribing from channels');
  ws.send(JSON.stringify({ op: 'unsubscribe', args: channels }));
};
