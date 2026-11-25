import WebSocket from 'ws';
import type { RabbitMQ } from '@devvir/service-kit';

export interface Config {
  workerUuid:  string;
  rabbitmqUrl: string;

  /** Venues this instance collects, from `HOARDER_VENUES`. Each must be a known venue. */
  venues:      readonly string[];

  [key: string]: unknown;
}

export interface State {
  broker:         RabbitMQ.Broker | null;
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

/** A venue-tagged inbound frame, on its way to the relay. */
export type MessageHandler = (msg: Buffer, venue: string) => Promise<void>;
