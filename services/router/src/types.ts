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

/** Router configuration. A type alias, so that it fits the service spec's `config` record. */
export type Config = {
  rabbitmqUrl: string;
  routes: Route[];
  prefetch: number;      // Max unacknowledged messages the router holds per source queue
  maxReady: number;      // Max messages in any watched queue before pausing (0 = disabled)
  watchQueues: string[]; // Queues to monitor for backpressure (set exactly when maxReady > 0)
};
