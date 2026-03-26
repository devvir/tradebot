import type { WebSocket, WebSocketServer } from 'ws';
import type { BitmexDataMessage } from '@tradebot/types';

export interface Config {
  snapshotsUrl: string;
  broadcastUrl: string;
  [key: string]: unknown;
}

// --- RabbitMQ deltas queue -----------------------------------------

export interface DeltaEvent {
  delta: BitmexWsMessage;
  counter: number;
  wss: WebSocketServer;
}

// --- BitMEX WebSocket protocol -------------------------------------

export type BitmexWsMessage = BitmexDataMessage;

export interface SubscribeOp {
  op: 'subscribe' | 'unsubscribe';
  args: string[];
}

export interface Buffered {
  msg: BitmexWsMessage;
  messageCount: number;
};

export interface PendingSubscriber {
  ws:                    WebSocket;
  key:                   string;
  symbol:                string;
  snapshot:              BitmexWsMessage;
  snapshotMessageCount:  number;
};