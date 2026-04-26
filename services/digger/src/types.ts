import type { RabbitMQ, Broker } from '@devvir/service-kit';
import type {
  BitmexTable,
  BitmexAction,
  BitmexFieldType,
} from '@tradebot/types';

// ── Config ────────────────────────────────────────────────────────────────────

export interface Config {
  workerUuid:          string;
  database:            string;

  /** How many docs remain in a buffer before a refetch is triggered. */
  bufferLowWatermark:  number;

  /** How many docs to fetch per MongoDB query. */
  bufferBatchSize:     number;

  /**
   * Optional RabbitMQ backpressure: queue name → max ready+unacked depth.
   * Passed straight to exchange.publish() via `waitIf`. When unset, no gating.
   */
  waitIfQueues?:       Record<string, number>;

  /**
   * Optional initial replay clock (epoch ms). When set, digger seeds
   * `clock.set(startTime)` at boot so subscriptions can run immediately
   * without an explicit `POST /set-clock` call.
   */
  startTime?:          number;

  [key: string]: unknown;
}

// ── State ─────────────────────────────────────────────────────────────────────

export interface State {
  subscriptions:  Map<string, Subscription>;
  buffers:        Map<string, TableBuffer>;
  broker:         Broker | null;
  isShuttingDown: boolean;

  /**
   * True while a `POST /set-clock` is in progress. The streaming engine sleeps
   * instead of publishing so the watched queues can drain to empty before the
   * clock jumps and buffers are rebuilt at the new position.
   */
  isPaused:       boolean;

  /** Total messages published since startup. Wired into the health check by trackMessages. */
  messages:       number;
  lastMessageAt:  number | null;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface Subscription {
  table: BitmexTable;
}

// ── Buffers ───────────────────────────────────────────────────────────────────

export interface TableBuffer {
  table:      BitmexTable;

  /** Pre-fetched raw MongoDB documents, in ascending _id order. */
  entries:    MongoDoc[];

  /**
   * The _id of the last fetched document, used to page forward.
   * null = not yet started; the first fetch seeks to the current replay clock.
   * Backfill (cold ws-origin partial reconstruction) seeds it before the first
   * stream fetch so we don't republish the docs we already fed to snapshots.
   */
  cursor:     number | null;

  isFetching: boolean;

  /**
   * Set to true once the fetcher returns fewer docs than bufferBatchSize —
   * meaning we have reached the end of the available data. The stream keeps
   * draining remaining entries and then stops for this table.
   */
  exhausted:  boolean;
}

/**
 * A raw document as returned by MongoDB.
 *
 * WS-origin shape  (instrument, orderBookL2, liquidation, ...):
 *   { _id, table, action, data, keys?, types?, filter? }
 *
 * REST-origin shape (trade, quote, funding, settlement, insurance, bins, ...):
 *   { _id, timestamp, symbol?, ... }
 */
export type MongoDoc = Record<string, unknown> & { _id: number };

// ── WS message contracts ──────────────────────────────────────────────────────

/**
 * A WS-format message published to the replay exchange.
 * Mirrors the BitMEX WS message structure that broadcast also emits.
 */
export interface WsMessage {
  table:        BitmexTable;
  action:       BitmexAction;
  data:         unknown[];
  keys?:        string[];
  types?:       Record<string, BitmexFieldType>;
  filter?:      Record<string, unknown>;
  attributes?:  Record<string, string>;
  foreignKeys?: Record<string, string>;
}

/** A single publishable unit handed from a table handler to the stream. */
export interface OutboundMessage {
  table:     BitmexTable;
  action:    BitmexAction;
  /** Epoch ms — the data timestamp (not wall clock). */
  timestamp: number;
  payload:   WsMessage;
}

/** Return value of TableHandler.take(). */
export interface TakeResult {
  messages: OutboundMessage[];
  /** How many docs were consumed from the front of the buffer. */
  consumed: number;
}

// ── Re-export for convenience ─────────────────────────────────────────────────

export type { RabbitMQ, BitmexTable, BitmexAction, BitmexFieldType };
