import type { BitmexTable, BitmexAction, BitmexFieldType } from '@tradebot/types';

export interface Config {
  /** Base URL of the librarian instance this provider reads from. */
  librarianUrl:  string;
  [key: string]: unknown;
}

/** Opaque data item — the provider passes data through without inspecting fields. */
export type DataItem = Record<string, unknown>;

/** A stored mongo doc (shape varies by table; always carries a numeric `_id`). */
export type StoredDoc = DataItem & { _id: number };

/**
 * A BitMEX WS message envelope as served to clients — the live wire shape:
 * no top-level `timestamp` (that lives on the data items); `keys`/`types`/`filter`
 * only on partials; `filterKey` only on chat.
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

/** One stream entry: the wire message plus its epoch-ms timestamp (for digger's merge). */
export interface StreamItem {
  ts:  number;
  msg: WsMessage;
}

/**
 * `GET /ws/:table` response. `cursor` is the opaque value to pass back as
 * `after` for the next page (or `null` when exhausted).
 */
export interface StreamResponse {
  messages:  StreamItem[];
  cursor:    number | null;
  exhausted: boolean;
}

/**
 * `GET /ws/:table/partial` response. `partial` is the message to apply
 * (raw stored partial for message tables, static schema partial for flat
 * tables, empty for order books, `null` if none). `cursor` is where digger
 * begins paging the forward stream.
 */
export interface PartialResponse {
  partial: WsMessage | null;
  cursor:  number | null;
}

/** How a table is stored, and therefore how it is shaped for WS. */
export type TableKind = 'message' | 'flat' | 'orderbook';

/** Read parameters accepted by the librarian seam. */
export interface ReadOpts {
  from?:   number;
  before?: number;
  order?:  'asc' | 'desc';
  limit?:  number;
  filter?: Record<string, unknown>;
}

/** Result of grouping flat records into WS inserts. */
export interface Grouped {
  items:      StreamItem[];
  /** `_id` of the last consumed doc, or `null` when nothing was consumed. */
  consumedId: number | null;
}

/** Normalised BitMEX REST query params (digger resolves "now" to concrete bounds first). */
export interface RestParams {
  symbol?:    string;
  count:      number;
  start:      number;
  reverse:    boolean;
  startTime?: number;
  endTime?:   number;
  columns?:   string[];
  /** orderBook/L2 levels per side (default 25; 0 = full). */
  depth?:     number;
}

/**
 * REST serving strategy per BitMEX endpoint semantics (verified against
 * swagger.json + live API):
 *   historical — honour the full time range (trade, quote, funding, bins, …).
 *   recent     — last `count` records, no time filtering (chat, announcement).
 *   state      — current row set reconstructed at the clock (orderBookL2,
 *                instrument, liquidation).
 */
export type RestKind = 'historical' | 'recent' | 'state';
