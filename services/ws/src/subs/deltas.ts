import { deltaChannel, deltaWildcard } from '../events';
import type { Bus, DeltaChannelEvent } from '../events';
import type { BitmexWsMessage } from '../types';

/**
 * Process one incoming delta from the RabbitMQ queue.
 *
 * Emits two bus events per delta:
 *   - 'delta:orderBookL2:XBTUSD'   (per-symbol, for fine-grained listeners)
 *   - 'delta:orderBookL2:*'        (per-table wildcard, for subscription routing)
 */
export const processDelta = (delta: BitmexWsMessage, counter: number, bus: Bus): void => {
  const symbol = getSymbol(delta);
  const event: DeltaChannelEvent = { delta, counter };

  bus.emit(deltaChannel(delta.table, symbol), event);
  bus.emit(deltaWildcard(delta.table),        event);
};

// ---- Helpers ------------------------------------------------------------

const getSymbol = (delta: BitmexWsMessage): string =>
  (delta.data[0] as { symbol?: string } | undefined)?.symbol ?? '_';
