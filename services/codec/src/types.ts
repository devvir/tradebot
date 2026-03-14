import type { BitmexDataItem, BitmexTable } from '@tradebot/types';

export interface Config {
  rabbitmqUrl: string;
  prefetch: number;
  [key: string]: unknown;
}

export type Strategy = typeof STRATEGIES[number];

export const STRATEGIES = [ 'encode', 'decode' ] as const;

export interface Message {
  table: BitmexTable;
  action: 'partial' | 'insert' | 'update' | 'delete';
  data?: unknown;
  b?: DecodedMessageData;
}

export type DecodedMessageData = string | Buffer<ArrayBuffer> | Record<string, unknown[]>;

export type EncodedMessage = Message & { data?: never; b: DecodedMessageData; };
export type DecodedMessage = Message & { data: BitmexDataItem[]; b?: never };
