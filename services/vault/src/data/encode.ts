// Row / WS message → CSV line encoding.
//
// The conversion happens here, before lines are pushed into the buffer, so the
// buffer only ever sees ready-to-write strings. `headersFor` gives the
// authoritative column ordering for every table — never inferred from data,
// because WS update messages only include changed fields.

import { rowToCsv } from '@tradebot/utils';
import { headersFor } from './headers';
import type { Row, WsMessage } from './types';

/**
 * Encodes a single body item — either a REST row or a WS message — into one or
 * more CSV lines ready for the buffer.
 *
 * REST rows produce one line. WS messages produce one line per `data` item;
 * the first line carries `_date_` and `_action_` metadata, subsequent lines
 * leave those columns empty so a reader can detect message boundaries by a
 * non-empty `_date_`. An empty `data: []` still produces one line with the
 * metadata so the message itself is not lost.
 */
export const encode = (table: string, item: Row | WsMessage): string[] => {
  const cols = headersFor(table);

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  if ('action' in item && Array.isArray((item as WsMessage).data)) {
    return encodeMessage(item as WsMessage, cols);
  }

  return [rowToCsv(item as Row, cols)];
};

const encodeMessage = (msg: WsMessage, cols: string[]): string[] => {
  const date   = msg.date ?? new Date().toISOString();
  const action = msg.action;
  const rows   = msg.data;

  if (rows.length === 0) {
    return [rowToCsv({ _date_: date, _action_: action }, cols)];
  }

  return rows.map((row, i) => {
    const enriched = i === 0
      ? { ...row, _date_: date, _action_: action }
      : row;

    return rowToCsv(enriched, cols);
  });
};
