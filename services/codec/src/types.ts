import type { Broker } from '@devvir/rabbitmq';

export interface CodecState {
  rabbitmqBroker: Broker | null;
  isShuttingDown: boolean;
  messagesProcessed: number;
  messagesPublished: number;
  lastProcessedTime: number;
}

export interface HealthState {
  mqConnected: boolean;
  messagesProcessed: number;
  messagesPublished: number;
  lastProcessedTime: number;
}
