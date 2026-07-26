import { TABLE_SPECS } from '@tradebot/utils';
import { seekId } from './seek';
import type { BitmexTable } from '@tradebot/types';
import type { Librarian } from '../librarian';
import type { WsMessage } from '../types';

/**
 * Schema-only partial (empty data) for flat and order-book tables — these have
 * no stored partial, so the schema comes from `TABLE_SPECS`. `chat` is a message
 * table, not flat, so no `filterKey` case is needed here.
 */
export const staticPartial = (table: BitmexTable): WsMessage => {
  const spec = TABLE_SPECS[table];

  return { table, action: 'partial', data: [], keys: spec.keys, types: spec.types, filter: spec.filter };
};

/**
 * The latest stored partial at-or-before `beforeMs` for a message table — a
 * plain read, no folding (snapshot assembly is digger's). Locates the `_id` near
 * `beforeMs` by seek, then takes the nearest preceding `action: 'partial'` doc.
 * Strips `_id` + top-level `timestamp` to the wire shape; returns the doc's `_id`
 * so digger can page the deltas after it.
 */
export const latestPartial = async (
  lib: Librarian, table: BitmexTable, beforeMs: number,
): Promise<{ msg: WsMessage; id: number } | null> => {
  const at  = await seekId(lib, table, beforeMs);
  const doc = await lib.latestBefore(table, at - 1, { action: 'partial' });

  if (! doc) return null;

  const { _id, timestamp: _dropTs, ...rest } = doc;

  return { msg: rest as unknown as WsMessage, id: _id };
};
