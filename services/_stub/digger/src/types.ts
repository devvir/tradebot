export interface Config {
  /** Initial clock (epoch ms); frozen until a client subscribes. Undefined → unset. */
  startTime?:      number;

  /** Server ports — three distinct listeners (ws, rest, control). */
  wsPort:          number;
  restPort:        number;
  controlPort:     number;

  /** The two provider instances (ws firehose + dedicated rest). */
  providerWsUrl:   string;
  providerRestUrl: string;

  /** Reader paging. */
  batchSize:       number;
  lowWatermark:    number;

  /** Messages the streaming loop drains per event-loop turn (one pacer check + one yield each). */
  drainBatch:      number;

  /** Slowest-client backpressure thresholds, in bytes of socket `bufferedAmount`. */
  bpHigh:          number;
  bpLow:           number;

  [key: string]:   unknown;
}
