// Pending Review

import WebSocket from 'ws';
import type { Channel } from 'amqplib';

export interface FeedState {
  ws: WebSocket | null;
  channel: Channel | null;
  reconnectDelay: number;
  isShuttingDown: boolean;
  lastMessageTime: number;
  apiVersion: string | null;
  pingInterval: NodeJS.Timeout | null;
}

export interface Config {
  bitmexWsUrl: string;
  rabbitmqUrl: string;
  channels: string[];
  symbols: string[];
  symbolPatterns: string[];
  healthPort: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

export interface HealthState {
  wsConnected: boolean;
  lastMessageTime: number;
}
