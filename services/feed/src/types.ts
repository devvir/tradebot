import WebSocket from 'ws';
import type { Channel } from 'amqplib';

/**
 * BitMEX WebSocket message structure as received from BitMEX API
 */
export interface BitmexRawMessage {
  table: string;
  action: string;
  keys?: string[];
  types?: Record<string, string>;
  foreignKeys?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  data: Array<Record<string, unknown>>;
}

/**
 * BitMEX WebSocket message as stored/archived
 * Includes _apiVersion (added by feed service for schema tracking)
 * Includes _hash (added by archivist service for uniqueness and sorting)
 */
export interface BitmexWSMessage extends BitmexRawMessage {
  _apiVersion?: string;
  _hash?: string;
}

export interface FeedState {
  ws: WebSocket | null;
  channel: Channel | null;
  reconnectDelay: number;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
  pingInterval: NodeJS.Timeout | null;
}

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

/**
 * BitMEX subscription confirmation message
 */
export interface BitmexSubscriptionMessage {
  subscribe: string;
  success: boolean;
  request?: {
    op: string;
    args: string[];
  };
}

/**
 * BitMEX unsubscription confirmation message
 */
export interface BitmexUnsubscriptionMessage {
  unsubscribe: string;
  success: boolean;
  request?: {
    op: string;
    args: string[];
  };
}

/**
 * BitMEX info/welcome message
 */
export interface BitmexInfoMessage {
  info: string;
  version: string;
  timestamp: string;
  docs: string;
  limit?: {
    remaining: number;
  };
}

/**
 * Union type for all BitMEX WebSocket messages
 */
export type BitmexWebSocketMessage =
  | BitmexSubscriptionMessage
  | BitmexUnsubscriptionMessage
  | BitmexInfoMessage;

/**
 * Type guard for subscription messages
 */
export const isSubscriptionMessage = (data: unknown): data is BitmexSubscriptionMessage => {
  return typeof data === 'object' && data !== null && 'subscribe' in data;
};

/**
 * Type guard for unsubscription messages
 */
export const isUnsubscriptionMessage = (data: unknown): data is BitmexUnsubscriptionMessage => {
  return typeof data === 'object' && data !== null && 'unsubscribe' in data;
};

/**
 * Type guard for info messages
 */
export const isInfoMessage = (data: unknown): data is BitmexInfoMessage => {
  return typeof data === 'object' && data !== null && 'info' in data && 'version' in data;
};
