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
   * The venue's websocket endpoints, keyed by a venue-chosen logical name (a
   * single `public`, or one for each of its markets). A separate socket is
   * opened per endpoint, per socket key.
   */
  endpoints(): EndpointDefinition[];

  /** Which endpoint carries a given channel. */
  endpointFor(channel: string): string;

  /** Frame sent to subscribe to one channel. */
  subscribeFrame(channel: string): string;

  /**
   * Classify an inbound frame while awaiting a subscribe ack for `channel`:
   * `ok` confirms, `failed` rejects, `null` means "not an ack for this channel"
   * and the wait continues. A venue whose error frames name no channel reports
   * any error as `failed`; the subscriber, which sends one subscribe at a time
   * and knows which requests are still unanswered, decides whose refusal it is.
   */
  matchAck(frame: unknown, channel: string): AckResult;

  /**
   * Whether a frame carries market data. `false` for control traffic (acks,
   * heartbeats, welcome banners), which is logged and dropped rather than
   * published — it describes the connection, not the market.
   */
  isData(frame: unknown): boolean;

  /**
   * Description of a control frame, for the log: its text, and whether it
   * reports that the venue refused a request. `null` when the venue does not
   * recognise the frame — the relay warns instead.
   */
  describeControl?(frame: unknown): ControlDescription | null;

  /**
   * Sub-socket key for a channel, when one endpoint needs several sockets (a
   * venue's stream shard). Empty string keeps a single socket.
   */
  socketKey?(channel: string): string;
}

export type AckResult = 'ok' | 'failed' | null;

export interface ControlDescription {
  text:     string;
  /** The frame reports a refused request (an error, a rejected subscription). */
  failure?: boolean;
}
