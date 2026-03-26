import WebSocket from 'ws';
import type { RabbitMQ } from '@devvir/service-kit';

export {
  type BitmexWebSocketMessage,
  isBitmexDataMessage,
  isBitmexInfoMessage,
  isBitmexSubscriptionMessage,
  isBitmexUnsubscriptionMessage,
} from '@tradebot/types';

export interface Config {
  env: 'live' | 'testnet';
  workerUuid: string;
  rabbitmqUrl: string;
  realtimeWsUrl: string;
  platformWsUrl: string;
  channels: readonly string[];
  bouncerUrl:   string;
  bouncerToken: string;
  [key: string]: unknown;
}

export interface Credentials {
  apiKey:    string;
  expires:   number;
  signature: string;
}

export interface PoolEntry {
  ws:       WebSocket;
  channels: Set<string>;
}

export interface ConnectOptions {
  credentials?: Credentials;
  accountId?:   string;
  onReconnect?: (ws: WebSocket) => void;
}

export interface State {
  realtime: WebSocket | null;
  platform: WebSocket | null;
  broker: RabbitMQ.Broker | null;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
}

export type MessageHandler = (msg: Buffer, accountId?: string) => void;

export interface EndpointDefinition {
  name: 'realtime' | 'platform';
  url: string;
}

export type SubscribeHandler   = (channel: string, accountId?: string) => Promise<void>;
export type UnsubscribeHandler = (channel: string, accountId?: string, keepOpen?: boolean) => void;
