import type { BitmexTable } from '@tradebot/types';
import type { StreamItem } from '../core/types';
import type { TableBuffer } from './types';

/** Per-table FIFO of pre-fetched messages. The merge drains the head; the
 *  reader refills the tail from the provider. */

export const createBuffer = (table: BitmexTable): TableBuffer => ({
  table,
  entries:    [],
  cursor:     null,
  isFetching: false,
  exhausted:  false,
});

export const enqueue = (buffer: TableBuffer, items: StreamItem[]): void => {
  for (const item of items) buffer.entries.push(item);
};

export const peek = (buffer: TableBuffer): StreamItem | undefined =>
  buffer.entries[0];

export const hasNext = (buffer: TableBuffer): boolean =>
  buffer.entries.length > 0;

/** True when a background refill is warranted. */
export const needsRefetch = (buffer: TableBuffer, lowWatermark: number): boolean =>
  ! buffer.isFetching &&
  ! buffer.exhausted  &&
  buffer.cursor !== null &&
  buffer.entries.length < lowWatermark;
