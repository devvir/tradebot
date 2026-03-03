import type { TopologySpec } from '@devvir/rabbitmq';

export type { TopologySpec };

export interface ExchangeSpec {
  name: string;
  type?: 'fanout' | 'topic' | 'direct' | 'headers';
}

export interface Binding {
  source: ExchangeSpec;
  destination: ExchangeSpec;
  routingKey?: string;
}

export interface Config {
  rabbitmqUrl: string;
  topology: TopologySpec;
}
