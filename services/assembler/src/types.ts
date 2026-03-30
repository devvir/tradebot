import type { RabbitMQ } from '@devvir/service-kit';
import type { BitmexFieldType } from '@tradebot/types';

export type Broker = RabbitMQ.Broker;

export interface Config {
  queueUrl: string;
  prefetch: number;
  [key: string]: unknown;
}

/** A WS message as stored by vault and forwarded by clerk. */
export interface WsMessage {
  action: string;
  date:   string;
  data:   Record<string, unknown>[];
}

/** A reconstructed WS message ready for publishing. */
export interface ReconstructedMessage {
  table:      string;
  action:     string;
  data:       Record<string, unknown>[];
  keys?:      string[];
  types?:     Record<string, BitmexFieldType>;
  filter?:    Record<string, unknown>;
  filterKey?: string;
  timestamp:  string;
}
