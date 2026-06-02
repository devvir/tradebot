import { toMs } from './time';
import type { StoredDoc, StreamItem, WsMessage } from '../types';

/**
 * Message tables (the 7 `WS_TABLES`) are stored as complete WS messages with
 * `table` present and a top-level `timestamp` (the query/merge key). The live
 * wire shape carries neither `_id` nor a top-level `timestamp` — both are
 * stripped; action/data and any partial metadata (keys/types/filter/filterKey)
 * pass through unchanged.
 */
export const messageItem = (doc: StoredDoc): StreamItem => {
  const { _id: _dropId, timestamp, ...rest } = doc;

  return { ts: toMs(timestamp as string), msg: rest as unknown as WsMessage };
};
