import type { Broker } from '@devvir/rabbitmq';

export interface Config {
  rabbitmqUrl: string;
  prefetch: number;
}

export interface CodecState {
  rabbitmqBroker: Broker | null;
  isShuttingDown: boolean;
  messagesProcessed: number;
  lastProcessedTime: number;
}

export type Strategy = typeof STRATEGIES[number];

export const STRATEGIES = [ 'encode', 'compress', 'decode' ] as const;
