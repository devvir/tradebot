import type { Table, TableTypeMap, BitmexTable } from '@devvir/bitmex-database';

import type { InstrumentItem, InstrumentMsg, CompositeIndexRow } from '../../types';

export type { InstrumentItem, InstrumentMsg, CompositeIndexRow };

// ── Source tables ─────────────────────────────────────────────────────────────

/** A proxy table that feeds synthetic instrument generation. */
export type ProxySource = 'compositeIndex' | 'tick' | 'quote' | 'trade' | 'funding' | 'settlement';

/** Every table the distiller reads — the walked `instrument` plus the six proxies. */
export type SourceTable = 'instrument' | ProxySource;

/** First date with any instrument data; the universe starts here. */
export const UNIVERSE_START = '2019-04-01';

/**
 * Tables whose import progress bounds the universe — `instrument` plus the five
 * gating proxies. `settlement` is sparse and never gates; it is consumed where
 * present.
 */
export const GATING_TABLES: SourceTable[] = ['instrument', 'compositeIndex', 'tick', 'quote', 'trade', 'funding'];

// ── Proxy rows ────────────────────────────────────────────────────────────────

export type QuoteRow      = TableTypeMap[BitmexTable.Quote]      & { _id: number };
export type TradeRow      = TableTypeMap[BitmexTable.Trade]      & { _id: number };
export type FundingRow    = TableTypeMap[BitmexTable.Funding]    & { _id: number };
export type SettlementRow = TableTypeMap[BitmexTable.Settlement] & { _id: number };

/**
 * A referential index tick — BitMEX's size-0 `trdType: 'Referential'` trade for
 * an index symbol, collected into the `tick` table. The index value it carries
 * equals the `compositeIndex` BMI value; `tick` is its fallback source.
 */
export interface TickRow {
  _id:           number;
  timestamp:     string;
  symbol:        string;
  price:         number;
  tickDirection: string;
}

/** A raw proxy row that the Synthesizer transforms into instrument fields. */
export type EventRow = CompositeIndexRow | TickRow | QuoteRow | FundingRow | SettlementRow;

/** Proxy sources whose rows the Synthesizer transforms directly. `trade` is not
 *  here — it reaches the Walker pre-digested as `rolling` items (see §5.2). */
export type EventSource = 'compositeIndex' | 'tick' | 'quote' | 'funding' | 'settlement';

// ── Hourly buckets ────────────────────────────────────────────────────────────

/** One hour of every source table, as the Reader serves it. */
export interface HourBuckets {
  instrument:     InstrumentMsg[];
  compositeIndex: CompositeIndexRow[];
  tick:           TickRow[];
  quote:          QuoteRow[];
  trade:          TradeRow[];
  funding:        FundingRow[];
  settlement:     SettlementRow[];
}

// ── The Walker's input stream ─────────────────────────────────────────────────

/**
 * One entry of the timestamp-ordered stream the Provider hands the Walker.
 *
 * - `real`    — a real instrument document; applied and passed through.
 * - `event`   — a raw proxy row; transformed by the Synthesizer.
 * - `rolling` — a pre-digested field set from the rolling 24h window (a
 *   per-trade delta or a per-minute 24h-stats block).
 */
export type StreamItem =
  | { kind: 'real';    ms: number; doc: InstrumentMsg }
  | { kind: 'event';   ms: number; source: EventSource; row: EventRow }
  | { kind: 'rolling'; ms: number; symbol: string; fields: Partial<InstrumentItem> };

// ── Rolling 24h window ────────────────────────────────────────────────────────

/** Per-symbol 24h rolling window backing the trade-driven stats block. */
export interface RollingState {
  window:       { ms: number; size: number; grossValue: number; homeNotional: number; foreignNotional: number }[];
  priceHistory: { ms: number; price: number }[];

  /** Running sums over `window` — maintained on every push/shift, O(1) per trade. */
  volume24h:          number;
  turnover24h:        number;
  homeNotional24h:    number;
  foreignNotional24h: number;

  totalVolume:   number;
  totalTurnover: number;

  /** Last vwap emitted on a minute-cron tick; used for change detection. */
  lastVwap: number | undefined;
}

// ── Accumulator ───────────────────────────────────────────────────────────────

/** Per-symbol cache for fields derived from more than one source. */
export interface InstrumentSymCacheEntry {
  lastPrice?: number;
  markPrice?: number;
  bidPrice?:  number;
  askPrice?:  number;
  tickSize?:  number;
  fairBasis?: number;
}

/**
 * The Walker-owned instrument state: the `bitmex-database` accumulator table
 * plus the caches synthesis reads — all a pure projection of the table.
 */
export interface Accumulator {
  table:        Table<InstrumentItem>;
  refMap:       Map<string, string[]>;
  knownSymbols: Set<string>;
  symCache:     Map<string, InstrumentSymCacheEntry>;
  settled:      Set<string>;
}

// ── Resume state ──────────────────────────────────────────────────────────────

/** Phase of the two-phase hour commit held in the `distiller_instrument` key. */
export type Phase = 'sealed' | 'complete';

/** The distiller's entire resume state — anchor `_id` and commit phase. */
export interface ResumeState {
  anchorId: number;
  phase:    Phase;
}
