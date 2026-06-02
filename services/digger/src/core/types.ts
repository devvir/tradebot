import type { BitmexTable, BitmexAction, BitmexFieldType } from '@tradebot/types';

/** Opaque data item — digger forwards data without inspecting fields. */
export type DataItem = Record<string, unknown>;

/**
 * A BitMEX WS message — the live wire shape (no `_id`, no top-level `timestamp`).
 * Digger receives these from the provider, forwards them to clients, and feeds
 * them to the snapshot accumulator.
 */
export interface WsMessage {
  table:      BitmexTable;
  action:     BitmexAction;
  data:       DataItem[];
  keys?:      string[];
  types?:     Record<string, BitmexFieldType>;
  filter?:    Record<string, unknown>;
  filterKey?: string;
}

/** A stream entry from the provider: wire message + its epoch-ms merge timestamp. */
export interface StreamItem {
  ts:  number;
  msg: WsMessage;
}

/**
 * Normalised BitMEX REST params after digger has resolved "now" and capped any
 * future bound against the clock. Forwarded to the provider's `/rest` endpoint.
 */
export interface RestParams {
  symbol?:    string;
  count:      number;
  start:      number;
  reverse:    boolean;
  startTime?: number;
  endTime?:   number;
  columns?:   string[];
  /** orderBook/L2 levels per side. */
  depth?:     number;
}
