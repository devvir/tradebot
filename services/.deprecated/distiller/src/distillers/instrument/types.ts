import type { Table, TableTypeMap, BitmexTable } from '@devvir/bitmex-database';

import type { InstrumentItem, InstrumentMsg, CompositeIndexRow } from '../../types';

export type { InstrumentItem, InstrumentMsg, CompositeIndexRow };

// ── Source tables ─────────────────────────────────────────────────────────────

/** A proxy table that feeds synthetic instrument generation. */
export type ProxySource = 'compositeIndex' | 'tick' | 'quote' | 'trade' | 'funding' | 'settlement';

/** Every table the distiller reads — the walked `instrument` plus the six proxies. */
export type SourceTable = 'instrument' | ProxySource;

/**
 * Tables whose import progress bounds the universe — `instrument` plus the five
 * gating proxies.
 *
 * `settlement` is deliberately excluded: it is so sparse (often one or two dates
 * in a month) that gating on it would hold the whole universe a month back
 * waiting for the next entry. Whatever settlement data exists is consumed within
 * the boundary the other tables define; none of it is assumed missing.
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

/** The oldest hour the Reader serves, with that hour's buckets. */
export interface ServedHour {
  hour:    string;
  buckets: HourBuckets;
}

// ── Reader partitions ─────────────────────────────────────────────────────────

/**
 * A contiguous `_id` sub-range to read as one unit — the raw output of partition
 * discovery (`partitions.ts`), before the Reader wraps it in read state. A
 * symbol-major (clustered) proxy table yields one partition per symbol run; a
 * time-ordered table yields a single whole-day partition. `hiExcl` is exclusive.
 */
export interface Partition {
  lo:     number;
  hiExcl: number;
}

/** An `_id` paired with its symbol — one endpoint or probe in boundary discovery. */
export interface BoundaryProbe {
  id:  number;
  sym: string;
}

/**
 * One read cursor over a `Partition`: the Reader's per-partition read state. Each
 * partition is read ahead independently to the warm horizon, so a last-sorted
 * cluster's early-hour rows are read before serving passes them.
 */
export interface PartitionCursor {
  lo:        number;
  hiExcl:    number;
  cursor:    number;
  frontier:  string;
  firstHour: string;
  done:      boolean;
}

// ── Conflator ─────────────────────────────────────────────────────────────────

/** One net-changed conflated delta the Conflator emits on a tick boundary. */
export interface ConflatorEmit {
  symbol: string;
  fields: Partial<InstrumentItem>;
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

/** One minute's trade aggregates inside the rolling window. `ms` is minute-aligned. */
export interface RollingMinuteBin {
  ms:              number;
  size:            number;
  grossValue:      number;
  homeNotional:    number;
  foreignNotional: number;
}

/** The last trade of one minute — exact `ms` and price, for `prevPrice24h`. */
export interface RollingPricePoint {
  ms:    number;
  price: number;
}

/**
 * Per-symbol 24h rolling window backing the trade-driven stats block. Holds
 * per-minute aggregates — never individual trades — so memory is bounded by the
 * window's minute count (~1441 per symbol) regardless of trade volume. The
 * `head` indexes mark each array's first live entry: eviction advances them and
 * the arrays are compacted periodically — no per-element `shift()`.
 */
export interface RollingState {
  window:       RollingMinuteBin[];
  windowHead:   number;
  priceHistory: RollingPricePoint[];
  priceHead:    number;

  /** Running sums over the live window — maintained incrementally, O(1) per trade. */
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
  lastPrice?:  number;
  markPrice?:  number;
  bidPrice?:   number;
  askPrice?:   number;
  tickSize?:   number;
  fairBasis?:  number;
  markMethod?: string;
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
