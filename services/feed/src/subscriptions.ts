import WebSocket from 'ws';
import logger from '@tradebot/logger';

/**
 * Core subscription management logic - handles batching for any operation
 */
const manageSubscriptionBatch = (
  ws: WebSocket,
  topics: string[],
  op: 'subscribe' | 'unsubscribe',
  batchSize: number,
  batchDelay: number
): void => {
  for (let i = 0; i < topics.length; i += batchSize) {
    const batch = topics.slice(i, i + batchSize);
    const delayMs = (i / batchSize) * batchDelay;

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        logger.debug({ op, batch: batch.length, total: topics.length }, 'Sending batch');
        ws.send(JSON.stringify({ op, args: batch }));
      }
    }, delayMs);
  }
};

/**
 * Subscribe to multiple BitMEX topics in batches
 */
export const subscribeToTopics = (
  ws: WebSocket,
  topics: string[],
  batchSize: number,
  batchDelay: number
): void => {
  logger.info({ topicCount: topics.length }, 'Subscribing to topics in batches');
  manageSubscriptionBatch(ws, topics, 'subscribe', batchSize, batchDelay);
};

/**
 * Unsubscribe from multiple BitMEX topics in batches
 */
export const unsubscribeFromTopics = (
  ws: WebSocket,
  topics: string[],
  batchSize: number,
  batchDelay: number
): void => {
  logger.info({ topicCount: topics.length }, 'Unsubscribing from topics in batches');
  manageSubscriptionBatch(ws, topics, 'unsubscribe', batchSize, batchDelay);
};
