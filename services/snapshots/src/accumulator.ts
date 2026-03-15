import { logger } from '@devvir/service-kit';
import type { BitmexDataItem, Message, Snapshot, SnapshotIndexedData } from './types';

const MAX_ITEMS_PER_TABLE = 10_000;

/**
 * Start a new table snapshot or replace an existing one.
 */
export const newSnapshot = (message: Snapshot): Snapshot => {
  const keys = message.keys as (keyof BitmexDataItem)[];
  const index: SnapshotIndexedData = new Map();

  /** Tables without keys are insert-only and don't use indexing */
  if (keys.length === 0) return message;

  for (const item of message.data as BitmexDataItem[]) {
    const id = keys.map(key => item[key]).join('|');
    index.set(id, item);
  }

  message.data = index; /** Replace array with indexed data */

  return message;
}

/**
 * Apply insert/update/delete deltas to an existing snapshot, using index if available.
 */
export const applyDelta = (snapshot: Snapshot, message: Message): void => {
  snapshot.counter = message.counter;

  if (snapshot.keys.length)
    updateFromIndex(snapshot, message);

  else if (message.action === 'insert') {
    const data = snapshot.data as BitmexDataItem[];
    data.push(...message.data);

    if (data.length > MAX_ITEMS_PER_TABLE * 1.1)
      data.splice(0, data.length - MAX_ITEMS_PER_TABLE);
  }

  else
    logger.error({ action: message.action, table: message.table }, 'Cannot modify item without keys');
};

const updateFromIndex = (snapshot: Snapshot, message: Message): void => {
  const keys = snapshot.keys as (keyof BitmexDataItem)[];
  const index = snapshot.data as SnapshotIndexedData;

  for (const item of message.data) {
    const id = keys.map(key => item[key]).join('|');

    if (message.action === 'insert')
      index.set(id, item);

    else if (message.action === 'update')
      index.set(id, Object.assign(index.get(id) || {}, item));

    else if (message.action === 'delete')
      index.delete(id);
  }
};
