import WebSocket from 'ws';
import type { Broker } from '@devvir/rabbitmq';

export {
  type BitmexWebSocketMessage,
  isBitmexDataMessage,
  isBitmexInfoMessage,
  isBitmexSubscriptionMessage,
  isBitmexUnsubscriptionMessage,
} from '@tradebot/types';

export interface Config {
  env: 'live' | 'testnet';
  realtimeWsUrl: string;
  platformWsUrl: string;
  realtimeChannels: readonly string[];
  platformChannels: readonly string[];
  queue: {
    rabbitmqUrl: string;
    messageTtlMs: number;
  };
  connection: {
    reconnectDelayMs: number;
    maxReconnectDelayMs: number;
  };
}

export interface FeedState {
  realtime: WebSocket | null;
  platform: WebSocket | null;
  broker: Broker | null;
  reconnectDelay: number;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
  pingInterval: NodeJS.Timeout | null;
}

export interface HealthState {
  realtimeConnected: boolean;
  platformConnected: boolean;
  lastMessageTime: number;
}

export interface HealthCheckResult {
  isHealthy: boolean;
  statusCode: number;
  body: {
    status: string;
    realtimeConnected: boolean;
    platformConnected: boolean;
    lastMessage: number;
  };
}

export type MessageHandler = (msg: Buffer) => void;

export interface EndpointDefinition {
  name: 'realtime' | 'platform';
  url: string;
  channels: readonly string[];
};

export interface EndpointConnections {
  connectRealtime: () => void;
  connectPlatform: () => void;
};
