import type { RedisClient as SKRedisClient } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import type { Task } from './orchestration';

export type RedisClient = SKRedisClient;

export interface Config {
  database:           string;
  vaultUrl:           string;
  librarianUrl:          string;
  tables:             BitmexTable[];
  fileConcurrency:    number;
  readBufferHigh:     number;
  readBufferLow:      number;
  inflightCap:        number;
  wireBytesCap:       number;
  flushIntervalMs:    number;
  progressIntervalMs: number;
  metricsIntervalMs:  number;
  [key: string]:      unknown;
}

/**
 * The single object that flows through every pipeline stage. The property
 * set is stable across stages (V8 hidden-class friendly); stages mutate
 * `content` in place rather than spreading into a new shape:
 *
 *   - reader   sets `content` to the vault NDJSON line as-is
 *   - assemble (WS path only) replaces `content` with the wire-ready
 *     envelope (template-spliced for the common case, or parse +
 *     `reconstruct()` + stringify for the rare exception cases)
 *   - flusher  injects `_id` into `content` by string surgery
 *
 * `content` is always a JSON string that begins with `{`. No JSON.parse
 * runs on the hot path — keeping everything as text avoids V8's hidden-
 * class churn and GC pressure that nested POJOs cause at this volume.
 *
 * `table`, `date`, `type`, and `stopSignal` live on `task` — one shared
 * pointer per bucket, not duplicated per item. `position` is 1-based
 * (first message of a file is position 1).
 */
export interface Item {
  task:     Task;
  position: number;
  content:  string;
  /**
   * Item's wire size in bytes — the length of `content` as it will appear
   * in the request body. Set by the reader to `line.length` for REST items
   * (each line is the doc as-is); re-set by the assembler after splicing
   * the WS envelope template. Used by the flusher to bound each HTTP
   * request and the wire-inflight cap by actual bytes, so a fat partial
   * doesn't blow past the writer's body limit.
   */
  size:     number;
}

export interface BoundedBufferOpts {
  highWater: number;
  lowWater:  number;
  /** Fired the first time `push` blocks at the high watermark. */
  onPause?:  () => void;
  /** Fired when `push` resumes after draining to the low watermark. */
  onResume?: () => void;
}

export type FileState = 'open' | 'closed';

export interface BoundedBuffer<T> {
  /** Push one item. Resolves immediately unless the high watermark is reached. */
  push(item: T): Promise<void>;

  /**
   * Pop up to `max` oldest items as one batch. Resolves with the array, or
   * `undefined` once the buffer is closed and drained. Batched draining keeps
   * the internal array O(N) per batch instead of O(N) per item — important
   * when the buffer routinely runs in the tens of thousands.
   */
  pop(max: number): Promise<T[] | undefined>;

  /** Signal that no further items will be pushed. Idempotent. */
  close(): void;

  /** Current number of buffered items. */
  size(): number;
}
