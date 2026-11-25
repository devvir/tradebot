import type { RabbitMQ } from '@devvir/service-kit';
import type { QueueConfig } from './types';

/** The AMQP exchange hoarder publishes every frame to. */
const EXCHANGE = 'hoarder';

/**
 * Hoarder's broker topology: the topic exchange it publishes to, and one
 * durable queue bound to it for every routing key, so frames published while
 * no consumer is attached wait in the queue instead of being discarded.
 *
 * The queue is capped at `maxLength` frames with `drop-head` overflow: once it
 * is full, each new frame pushes out the oldest one, so a consumer that stays
 * away too long loses the start of the gap and the broker's disk stays bounded.
 *
 * Best effort: publishes are not confirmed, so a frame the broker loses before
 * enqueueing it is lost without notice.
 */
export const topologyFor = (queue: QueueConfig): RabbitMQ.TopologySpec => ({
  exchanges: {
    [EXCHANGE]: {
      type:   'topic',
      queues: {
        [queue.name]: {
          durable:    true,
          routingKey: '#',
          arguments:  { 'x-max-length': queue.maxLength, 'x-overflow': 'drop-head' },
        },
      },
    },
  },
});
