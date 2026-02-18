import WebSocket from 'ws';
import type { Broker } from '../../../packages/rabbitmq';
import {
  type BitmexSubscriptionMessage,
  type BitmexUnsubscriptionMessage,
  type BitmexInfoMessage,
  type BitmexWebSocketMessage,
  isBitmexSubscriptionMessage,
  isBitmexUnsubscriptionMessage,
  isBitmexInfoMessage,
} from '../../../shared/types';

export type FeedRole =
  | 'NONE'
  | 'GLOBAL'
  | 'LOW_VOLUME_1'
  | 'LOW_VOLUME_2'
  | 'LOW_VOLUME_3'
  | 'HIGH_VOLUME'
  | 'BITCOIN';

export interface Config {
  bitmexWsUrl: string;
  rabbitmqUrl: string;
  role: FeedRole;
  channels: string[];
  channelPatterns: string[];
  symbols: string[];
  symbolPatterns: string[];
  healthPort: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
  messageTtlMs: number;
  batchSizeChannels: number;
  batchDelayMs: number;
}

export interface FeedState {
  ws: WebSocket | null;
  broker: Broker | null;
  reconnectDelay: number;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
  pingInterval: NodeJS.Timeout | null;
}

export interface HealthState {
  wsConnected: boolean;
  lastMessageTime: number;
}

export interface HealthCheckResult {
  isHealthy: boolean;
  statusCode: number;
  body: {
    status: string;
    wsConnected: boolean;
    lastMessage: number;
  };
}

// Re-export BitMEX types for convenience in this service
export type {
  BitmexSubscriptionMessage,
  BitmexUnsubscriptionMessage,
  BitmexInfoMessage,
  BitmexWebSocketMessage,
};

// Re-export BitMEX type guards for convenience
export { isBitmexSubscriptionMessage, isBitmexUnsubscriptionMessage, isBitmexInfoMessage };
