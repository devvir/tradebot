import type { RabbitMQ } from '@devvir/service-kit';

export type Broker = RabbitMQ.Broker;

export interface Config {
  vaultUrl:       string;
  tables:         string[];
  maxReady:       number;
  watchQueues:    string[];
  [key: string]:  unknown;
}

/** A row as returned by vault — values are already typed. */
export type Row = Record<string, unknown>;

/** A WS message as stored and returned by vault. */
export interface WsMessage {
  action: string;
  date:   string;
  data:   Row[];
}

/** Returns true if the parsed line is a WS message object. */
export const isWsMessage = (item: unknown): item is WsMessage =>
  typeof item === 'object' &&
  item !== null &&
  ! Array.isArray(item) &&
  'action' in item &&
  'date'   in item &&
  'data'   in item &&
  Array.isArray((item as WsMessage).data);

export type FileState = 'open' | 'closed';
