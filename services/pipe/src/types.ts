import type { RabbitMQ } from '@devvir/service-kit';

export type TopologySpec = RabbitMQ.TopologySpec;
export type ExchangeSpec = RabbitMQ.ExchangeSpec;

/** Exchange destination, with an optional queue to assert and bind inside it. */
export type DestinationSpec = ExchangeSpec & { queue?: string };

export interface Binding {
  source:      ExchangeSpec;
  destination: DestinationSpec;
  routingKey?: string;
}

export interface Config {
  rabbitmqUrl: string;
  topology: TopologySpec;
  bindings: Binding[];
  [key: string]: unknown;
}
