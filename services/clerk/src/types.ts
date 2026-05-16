export type { Broker } from '@devvir/rabbitmq';

export interface Config {
  queueUrl:        string;
  vaultUrl:        string;
  tables:          string[];
  /** Per-queue depth thresholds that pause publishing when exceeded. */
  waitIf:          Record<string, number>;
  /** Number of parallel workers. Each owns its own broker / connection / channel. */
  fileConcurrency: number;
  /** Buffered items between ReadTask and PublishTask; push pauses at high, resumes at low. */
  readBufferHigh:  number;
  readBufferLow:   number;
  [key: string]:   unknown;
}

export interface BufferItem {
  /** Raw NDJSON line from vault — passed through to RabbitMQ untouched. */
  line:     string;
  msgIndex: number;
}

export interface FileWork {
  table: string;
  date:  string;
}

/**
 * Sent by clerk to registrar on the `control` routing key when a file has been
 * fully published. `highestIndex` is the 0-based absolute index of the last
 * message in the file (count - 1, or -1 for an empty file).
 */
export interface ControlMessage {
  type:         'complete';
  table:        string;
  date:         string;
  highestIndex: number;
}

export interface DateBatch {
  date:   string;
  tables: string[];
}

export interface BoundedBuffer<T> {
  /** Push one item. Resolves immediately unless backpressure is active. */
  push(item: T): Promise<void>;

  /**
   * Pop the oldest item. Resolves with the item, or `undefined` if the buffer
   * has been closed and is empty (use this as the end-of-stream signal).
   */
  pop(): Promise<T | undefined>;

  /** Signal that no further items will be pushed. Idempotent. */
  close(): void;

  /** Current number of buffered items. */
  size(): number;
}

export type FileState = 'open' | 'closed';

/** Context passed to vault fetch error mapping for useful error messages. */
export interface VaultReadContext {
  table:      string;
  date:       string;
  startFrom:  number;
  /** Absolute row index reached when the failure occurred (mid-stream only). */
  msgIndex?:  number;
}
