import { Broker, logger, Service } from '@devvir/service-kit';
import { venueFor } from './venues';
import type { ControlDescription } from './venues/types';
import type { Config, MessageHandler } from './types';

/**
 * Creates the relay: parse a frame, ask its venue whether it is market data,
 * publish it verbatim. The parsed value is used only to classify the frame; what
 * is published is the received buffer itself, so number text (trailing zeros,
 * exponents, integers beyond double precision), escapes and whitespace reach the
 * archive exactly as the venue sent them. Hoarder never reshapes a payload —
 * normalising across venues is a later stage's job, and a byte-faithful archive
 * is what makes that possible.
 *
 * The routing key is the venue name alone. Everything finer (table, action,
 * symbol) is venue-specific vocabulary a binding cannot express portably, and
 * it is already in the payload for consumers that care.
 *
 * Note `broker.getExchange()` is the *AMQP* exchange — the only meaning of
 * "exchange" inside this service. Trading exchanges are venues, everywhere.
 */
export const createMessageHandler = (service: Service, onMessage: () => void): MessageHandler => {
  const config = service.config() as Config;
  const broker = service.providers.get('rabbitmq') as Broker;

  return async (buffer: Buffer, venue: string): Promise<void> => {
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
          'x-venue':        venue,
          'x-hoarder-uuid': config.workerUuid,
          'x-collected-at': new Date().toISOString(),
        },
      });

      onMessage();
    } catch (err) {
      if (err instanceof Error && err.message === 'Channel closed')
        throw err;

      logger.error({ err, venue }, 'Error processing WebSocket message');
    }
  };
};

/** A venue refusing a request is worth seeing; the rest of the control chatter is not. */
const logControlFrame = (control: ControlDescription | null, frame: unknown, venue: string): void => {
  if (control?.failure)
    return logger.warn({ venue }, control.text);

  if (control)
    return logger.debug({ venue }, control.text);

  logger.warn({ venue, frame: JSON.stringify(frame).slice(0, 200) }, 'Unrecognized message received');
};
