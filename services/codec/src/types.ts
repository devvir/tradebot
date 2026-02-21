import type { Broker } from '@devvir/rabbitmq';

export interface Config {
  rabbitmqUrl: string;
}

export interface CodecState {
  rabbitmqBroker: Broker | null;
  isShuttingDown: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}

export interface HealthState {
  mqConnected: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}
