import type { EndpointDefinition } from '../types';

/**
 * Everything hoarder needs to know about one venue. The core (connection pool,
 * subscriber, relay) is written against this interface only — adding a venue
 * means adding one file that implements it, never touching the core.
 */
export interface Venue {
  /** Venue id: the `HOARDER_VENUES` token and the routing key of everything it publishes. */
  name: string;

  /**
   * The venue's websocket endpoints, keyed by a venue-chosen logical name (e.g.
   * BitMEX's `realtime` / `platform`, or a single `public`). A separate socket
   * is opened per endpoint, per socket key.
   */
  endpoints(): EndpointDefinition[];

  /** Which endpoint carries a given channel. */
  endpointFor(channel: string): string;

  /** Frame sent to subscribe to `channels`. */
  subscribeFrame(channels: string[]): string;

  /** Frame sent to unsubscribe from `channels`. */
  unsubscribeFrame(channels: string[]): string;

  /**
   * Classify an inbound frame while awaiting a subscribe ack for `channel`:
   * `ok` confirms, `failed` rejects, `null` means "not an ack for this channel"
   * and the wait continues.
   */
  matchAck(frame: unknown, channel: string): AckResult;

  /**
   * Whether a frame carries market data. `false` for control traffic (acks,
   * heartbeats, welcome banners), which is logged and dropped rather than
   * published — it describes the connection, not the market.
   */
  isData(frame: unknown): boolean;

  /**
   * Human-readable description of a control frame, for the debug log. `null`
   * when the venue does not recognise the frame — the relay warns instead.
   */
  describeControl?(frame: unknown): string | null;

  /**
   * Sub-socket key for a channel, when one endpoint needs several sockets (a
   * BitMEX pool, a venue's stream shard). Empty string keeps a single socket.
   */
  socketKey?(channel: string): string;
}

export type AckResult = 'ok' | 'failed' | null;

// ── BitMEX ────────────────────────────────────────────────────────────────────

/** The three BitMEX liquidity pools selectable on a market-data subscription. */
export type Pool = 'Primary' | 'Secondary' | 'Aggregated';

/** A BitMEX subscription arg split into its base channel and (optional) pool suffix. */
export interface ParsedChannel {
  base:  string;
  pool?: Pool;
}
