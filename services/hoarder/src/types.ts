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
  ws:       WebSocket;
  channels: Set<string>;
}

export interface ConnectOptions {
  /** Distinguishes sockets sharing an endpoint (a BitMEX pool, a stream shard). */
  socketKey?:   string;
  onReconnect?: (ws: WebSocket) => void;
}

export interface EndpointDefinition {
  name: string;
  url:  string;
}

/** A venue-tagged inbound frame, on its way to the relay. */
export type MessageHandler = (msg: Buffer, venue: string) => void;
