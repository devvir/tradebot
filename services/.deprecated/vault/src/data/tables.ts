/**
 * The table sets the store's codec keys on.
 */

/**
 * The base name of a possibly-qualified table name: `orderBookL2.secondary` →
 * `orderBookL2`. A `.qualifier` suffix scopes storage and carries no schema
 * meaning, so every per-table lookup (headers, casts, WS origin, free text)
 * keys on the base name and never needs to know which qualifiers exist.
 */
export const baseTable = (table: string): string => table.split('.')[0]!;

/**
 * Tables recorded as WebSocket message envelopes (`{ action, date, data[] }`)
 * rather than as per-row REST records. In tabular form each row carries
 * `_date_` and `_action_` columns, and one message spans consecutive rows: its
 * first row has a non-empty `_date_`, its continuation rows leave it empty.
 */
export const WS_TABLES = new Set<string>([
  'announcement',
  'chat',
  'connected',
  'instrument',
  'liquidation',
  'orderBookL2',
  'publicNotifications',
]);

/**
 * Tables whose fields can contain commas, double quotes or line breaks —
 * free-text content such as announcement bodies, chat messages and
 * notification text — and so need RFC 4180 quoting. Reading them takes a full
 * CSV parser: a line-based reader would split a quoted field at its embedded
 * line break.
 *
 * No other table holds free text, so no field of theirs contains a line break
 * and each physical line is exactly one record.
 */
export const FREE_TEXT_TABLES: ReadonlySet<string> = new Set([
  'announcement',
  'chat',
  'publicNotifications',
]);
