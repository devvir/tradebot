// Row / WS message → CSV line encoding.
//
// The conversion happens here, before lines are pushed into the buffer, so the
// buffer only ever sees ready-to-write strings. `headersFor` gives the
// authoritative column ordering for every table — never inferred from data,
// because WS update messages only include changed fields.

import { rowToCsv, FREE_TEXT_TABLES } from '@tradebot/utils';
import { baseTable, headersFor } from './headers';
import type { Row, WsMessage } from './types';

// Characters that make `rowToCsv` quote a value. Only free-text tables are read
// with a quote-aware parser, so no other table may store them.
const NEEDS_QUOTING = /[,"\r\n]/;

/**
 * Encodes a single body item — either a REST row or a WS message — into one or
 * more CSV lines ready for the buffer.
 *
 * REST rows produce one line. WS messages produce one line per `data` item;
 * the first line carries `_date_` and `_action_` metadata, subsequent lines
 * leave those columns empty so a reader can detect message boundaries by a
 * non-empty `_date_`. `_date_` and `_action_` keys inside `data` rows are
 * ignored: only the message sets them. An empty `data: []` still produces one
 * line with the metadata so the message itself is not lost.
 *
 * On every table outside FREE_TEXT_TABLES, a value that is an object or array,
 * or whose text contains `,`, `"`, `\r` or `\n`, throws naming the column, so
 * every line of such a table splits on commas into exactly its columns.
 */
export const encode = (table: string, item: Row | WsMessage): string[] => {
  const cols = headersFor(table);

  if (! cols) throw new Error(`No header definition for table '${table}'`);

  const freeText = FREE_TEXT_TABLES.has(baseTable(table));

  const toCsv = (row: Row): string => {
    if (! freeText) checkPlainValues(table, row, cols);

    return rowToCsv(row, cols);
  };

  if ('action' in item && Array.isArray((item as WsMessage).data)) {
    return encodeMessage(item as WsMessage, toCsv);
  }

  return [toCsv(item as Row)];
};

const encodeMessage = (msg: WsMessage, toCsv: (row: Row) => string): string[] => {
  const date   = msg.date ?? new Date().toISOString();
  const action = msg.action;
  const rows   = msg.data;

  if (rows.length === 0) {
    return [toCsv({ _date_: date, _action_: action })];
  }

  return rows.map((row, i) => {
    const data: Row = { ...row };

    delete data['_date_'];
    delete data['_action_'];

    return toCsv(i === 0 ? { ...data, _date_: date, _action_: action } : data);
  });
};

/** Throws when a column's value would need CSV quoting. */
const checkPlainValues = (table: string, row: Row, cols: string[]): void => {
  for (const col of cols) {
    const val = row[col];

    if (val === null || val === undefined) continue;

    if (typeof val === 'object')
      throw new Error(`Column '${col}' of table '${table}' must not hold an object or array`);

    if (NEEDS_QUOTING.test(String(val)))
      throw new Error(`Column '${col}' of table '${table}' must not contain a comma, double quote or line break`);
  }
};
