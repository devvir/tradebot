import WebSocket from 'ws';

export interface Config {
  workerUuid: string;

  /** Venues this instance collects, from `HOARDER_VENUES`. Each must be a known venue. */
  venues:     readonly string[];

  /** The queue that buffers every published frame. */
  queue:      QueueConfig;

  [key: string]: unknown;
}

export interface QueueConfig {
  /** Queue name, from `HOARDER_QUEUE`. */
  name:      string;

  /** Most frames the queue holds, from `HOARDER_QUEUE_MAX_LENGTH`; past it the oldest are dropped. */
  maxLength: number;
}

export interface State {
  isShuttingDown: boolean;
}

export interface PoolEntry {
  /**
   * The entry's current socket; replaced on every reconnect. Null when the
   * service was already shutting down as the entry was created.
   */
  ws:       WebSocket | null;

  /**
   * The channels this socket is meant to carry: a channel joins when it is
   * asked for, before any answer from the venue, and leaves only when the venue
   * rejects it. Every socket the entry opens subscribes all of them.
   */
  channels: Set<string>;
}

export interface ConnectOptions {
  /** Distinguishes sockets sharing an endpoint (a stream shard). */
  socketKey?:   string;
  onReconnect?: (ws: WebSocket) => void;

  /** Aborting it stops the endpoint for good: no socket is made or replaced after that. */
  signal?:      AbortSignal;
}

export interface EndpointDefinition {
  name: string;
  url:  string;
}

/**
 * An inbound frame on its way to the relay, tagged with its venue and with the
 * connection id of the socket that read it (one per socket, fresh on every
 * reconnect).
 */
export type MessageHandler = (msg: Buffer, venue: string, connectionId: string) => Promise<void>;
