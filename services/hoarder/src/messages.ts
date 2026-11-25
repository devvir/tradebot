import { Broker, logger, Service } from '@devvir/service-kit';
import { venueFor } from './venues';
import type { ControlDescription } from './venues/types';
import type { Config, MessageHandler } from './types';

/**
 * Creates the relay: parse a frame, ask its venue whether it is market data,
 * publish it verbatim. The parsed value is used only to classify the frame; what
 * is published is the received buffer itself, so number text (trailing zeros,
 * exponents, integers beyond double precision), escapes and whitespace are
 * published exactly as the venue sent them. Hoarder never reshapes a payload.
 *
 * Each published frame carries its envelope in headers: `x-venue`,
 * `x-hoarder-uuid` (this process), `x-connection-id` (the socket that read it,
 * so a change of id marks a reconnect and a possible gap) and `x-collected-at`.
 *
 * The routing key is the venue name alone. Everything finer (table, action,
 * symbol) is venue-specific vocabulary a binding cannot express portably, and
 * it is already in the payload.
 *
 * A publish failing because the broker's channel or connection is closed
 * (amqplib's IllegalOperationError) means nothing more can be published: the
 * first such failure is logged and shuts the service down, and the container
 * restart connects again. While the service is shutting down such failures are
 * expected and dropped silently. Any other failure is logged and the frame is
 * lost.
 *
 * Note `broker.getExchange()` is the *AMQP* exchange — the only meaning of
 * "exchange" inside this service. Trading exchanges are venues, everywhere.
 */
export const createMessageHandler = (service: Service, onMessage: () => void): MessageHandler => {
  const config = service.config() as Config;
  const broker = service.providers.get('rabbitmq') as Broker;

  let brokerLost = false;

  const onBrokerLost = (err: Error, venue: string): void => {
    if (brokerLost || service.state('isShuttingDown')) return;

    brokerLost = true;

    logger.error({ err, venue }, 'RabbitMQ channel lost; shutting down');

    // A shutdown that fails would leave a process that collects nothing: exit anyway.
    service.shutdown('RABBITMQ_LOST').catch(shutdownErr => {
      logger.error({ err: shutdownErr }, 'Shutdown failed; exiting');
      process.exit(1);
    });
  };

  return async (buffer: Buffer, venue: string, connectionId: string): Promise<void> => {
    try {
      var frame = JSON.parse(buffer.toString()) as unknown;
    } catch (error) {
      return logger.error({ err: error, venue }, 'Failed to parse WebSocket message');
    }

    try {
      const v = venueFor(venue);

      if (! v.isData(frame))
        return logControlFrame(v.describeControl?.(frame) ?? null, frame, venue);

      await broker.getExchange()!.publish(buffer, venue, {
        contentType: 'application/json',
        headers: {
          'x-venue':         venue,
          'x-hoarder-uuid':  config.workerUuid,
          'x-connection-id': connectionId,
          'x-collected-at':  new Date().toISOString(),
        },
      });

      onMessage();
    } catch (err) {
      if (isChannelClosed(err)) return onBrokerLost(err, venue);

      logger.error({ err, venue }, 'Error processing WebSocket message');
    }
  };
};

/** amqplib's error for any operation on a closed channel or connection. */
const isChannelClosed = (err: unknown): err is Error =>
  err instanceof Error && err.name === 'IllegalOperationError';

/** A venue refusing a request is worth seeing; the rest of the control chatter is not. */
const logControlFrame = (control: ControlDescription | null, frame: unknown, venue: string): void => {
  if (control?.failure)
    return logger.warn({ venue }, control.text);

  if (control)
    return logger.debug({ venue }, control.text);

  logger.warn({ venue, frame: JSON.stringify(frame).slice(0, 200) }, 'Unrecognized message received');
};
