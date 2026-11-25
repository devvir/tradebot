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
  broker:          RabbitMQ.Broker | null;
  isShuttingDown:  boolean;
  lastMessageTime: number;
}

export interface PoolEntry {
  /** The entry's current socket; replaced on every reconnect. */
  ws:       WebSocket;

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
}

export interface EndpointDefinition {
  name: string;
  url:  string;
}

/** A venue-tagged inbound frame, on its way to the relay. */
export type MessageHandler = (msg: Buffer, venue: string) => void;
