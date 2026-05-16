import type { RabbitMQ, RedisClient as SKRedisClient } from '@devvir/service-kit';

export type Broker        = RabbitMQ.Broker;
export type ConsumerEvent = RabbitMQ.ConsumerEvent;
export type RedisClient   = SKRedisClient;

export interface Config {
  database:           string;
  prefetch:           number;
  flushIntervalMs:    number;
  /** How often progress.ts dumps its in-memory state to Redis. */
  progressIntervalMs: number;
  [key: string]: unknown;
}

export interface PendingEntry {
  _id:      number;
  doc:      Record<string, unknown>;
  table:    string;
  date:     string;
  msgIndex: number;
  ack:      ConsumerEvent['ack'];
  nack:     ConsumerEvent['nack'];
}

/**
 * Control message published by clerk on the `control` routing key.
 * `type: 'complete'` means: the bucket has no more messages coming; its last
 * one had `highestIndex` as its msgIndex. Registrar marks the bucket done
 * once its own counter for that bucket reaches `highestIndex`.
 */
export interface ControlMessage {
  type:         'complete';
  table:        string;
  date:         string;
  highestIndex: number;
}

/**
 * Per-bucket progress state held in memory by progress.ts.
 * `counter` is the highest msgIndex confirmed safely stored in MongoDB.
 * `goal` is the highestIndex from clerk's `complete` control message — null
 * until that message arrives.
 */
export interface BucketState {
  table:   string;
  date:    string;
  counter: number;
  goal:    number | null;
}
