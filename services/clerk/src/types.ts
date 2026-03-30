import type { RabbitMQ } from '@devvir/service-kit';

export type Broker = RabbitMQ.Broker;

export interface Config {
  vaultUrl:       string;
  maxReady:       number;
  watchQueues:    string[];
  [key: string]:  unknown;
}
