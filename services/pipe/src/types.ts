import type { RabbitMQ } from '@devvir/service-kit';

export type TopologySpec = RabbitMQ.TopologySpec;

/** An exchange in a pipe binding. An exchange without a type is declared fanout. */
export interface PipeExchange {
  name:  string;
  type?: RabbitMQ.ExchangeType;
}

/** Exchange destination, with an optional queue to assert and bind inside it. */
export interface PipeDestination extends PipeExchange {
  queue?: string;
}

export interface Binding {
  source:      PipeExchange;
  destination: PipeDestination;
  routingKey?: string;
}

/** Pipe configuration. A type alias, so that it fits the service spec's `config` record. */
export type Config = {
  rabbitmqUrl: string;
  topology:    TopologySpec;
  bindings:    Binding[];
};
