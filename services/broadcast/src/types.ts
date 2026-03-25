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
  realtimeChannels: readonly string[];
  platformChannels: readonly string[];
  [key: string]: unknown;
}

export interface State {
  realtime: WebSocket | null;
  platform: WebSocket | null;
  broker: RabbitMQ.Broker | null;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
  pingInterval: NodeJS.Timeout | null;
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
