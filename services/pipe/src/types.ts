import type { RabbitMQ } from '@devvir/service-kit';

export type TopologySpec = RabbitMQ.TopologySpec;
export type ExchangeSpec = RabbitMQ.ExchangeSpec;

export interface Binding {
  source:      ExchangeSpec;
  destination: ExchangeSpec;
  routingKey?: string;
}

export interface Config {
  rabbitmqUrl: string;
  topology: TopologySpec;
  bindings: Binding[];
  [key: string]: unknown;
}
