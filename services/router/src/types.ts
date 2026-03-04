import type { Broker } from '@devvir/rabbitmq';

export interface Exchange {
  name: string;
  type?: 'fanout' | 'topic' | 'headers' | 'direct' | 'default';
}

export interface RoutingKeyConfig {
  value: string;
  replace?: string;
}

export interface RouteSource {
  queue: string;
  exchange?: Exchange;
  bindingKey?: string;
}

export interface RouteDestination {
  queue?: string;
  exchange?: Exchange;
  routingKey?: RoutingKeyConfig;
  headers?: Record<string, string>;
}

/** A single source → destination pair (normalized from multi-source/multi-dest rules). */
export interface Route {
  source: RouteSource;
  destination: RouteDestination;
}

export interface Config {
  rabbitmqUrl: string;
  routes: Route[];
}

export interface RouterResources {
  broker: Broker;
  routes: Route[];
}
