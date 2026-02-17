import type { Broker } from '../../../packages/rabbitmq';
import type { BitmexWSMessage } from '../../../shared/types';
import logger from './logger';

const consumerQueueName = 'bitmex-feed';

/**
 * Transform a BitMEX message. Currently passes through with minimal changes.
 * This is the place to add custom transformations for different message types.
 */
const transformMessage = (data: BitmexWSMessage): BitmexWSMessage => {
  // TODO: Add custom transformations here based on message table/action
  // Examples:
  // - Normalize field names
  // - Convert timestamps
  // - Calculate derived fields
  // - Filter sensitive data
  // For now, pass through as-is
  return data;
};

export const startConsuming = async (
  broker: Broker,
  onProcessMsg: () => void,
  onPublishMsg: () => void
): Promise<void> => {
  try {
    const inputQueue = broker.getQueue(consumerQueueName);
    const outputQueue = broker.getQueue('archivist');

    if (! inputQueue || ! outputQueue) {
      throw new Error('Required queues not found');
    }

    logger.info({ queue: consumerQueueName }, 'Starting message consumption');

    await inputQueue.consume(
      async (message, { ack, nack }) => {
        try {
          const data = message as BitmexWSMessage;
          const transformed = transformMessage(data);

          onProcessMsg();

          // Publish to archivist queue
          outputQueue.publish(transformed, { persistent: true });

          onPublishMsg();

          // Acknowledge the message
          ack();
        } catch (error) {
          logger.error({ error }, 'Error processing message');
          // Nack with requeue on error
          nack(true);
        }
      },
      { prefetch: 10 }
    );

    logger.info('Successfully started consuming messages');
  } catch (e) {
    logger.error({ e }, 'Failed to start consuming');
    throw e;
  }
};
