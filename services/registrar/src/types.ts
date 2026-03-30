import type { RabbitMQ } from '@devvir/service-kit';

export type Broker        = RabbitMQ.Broker;
export type ConsumerEvent = RabbitMQ.ConsumerEvent;

export interface Config {
  database:        string;
  prefetch:        number;
  flushIntervalMs: number;
  [key: string]: unknown;
}

export interface PendingEntry {
  _id:  number;
  doc:  Record<string, unknown>;
  ack:  ConsumerEvent['ack'];
  nack: ConsumerEvent['nack'];
}
