/**
 * Per-bucket aggregate. Tracks dispositions (drops + confirmed inserts),
 * ticks the contiguous-confirmed frontier to `progress` every second, and
 * finalizes itself once the reader has reported `totalMessages` and every
 * position has been disposed of with nothing still in flight.
 *
 * Task is self-managing: nothing outside this file needs to call any
 * shutdown / cleanup method. It uses the `progress` module's semantic
 * API; it doesn't know storage exists.
 *
 * `stopSignal` is the single, service-level shared object that flips on
 * graceful shutdown. Workers and the flusher check it to bail out of
 * their loops; Task itself uses it to skip its own tick once the
 * service is going down.
 *
 * Concurrency model: many `insertMany` calls can be in flight for the
 * same task at once, so confirmations arrive out of order. `noteDisposed`
 * uses a position witness (`nextExpected` + `disposedAhead`) so that the
 * exposed `messages` advances only across the contiguous-confirmed prefix.
 * That keeps the Redis progress tick safe for crash-resume: positions
 * below `messages` are guaranteed in mongo (or were dropped at assemble),
 * so the reader can skip them on the next run.
 */

import { logger } from '@devvir/service-kit';
import { WS_TABLES } from '@tradebot/utils';
import type { BitmexTable } from '@tradebot/types';
import { markDone, markProgress } from './progress';

export interface StopSignal {
  triggered: boolean;
}

export interface TaskOptions {
  table:       BitmexTable;
  date:        string;
  /** Messages already confirmed stored in a previous run. 0 for fresh. */
  skip:        number;
  intervalMs:  number;
  stopSignal:  StopSignal;
  onComplete?: (task: Task) => void;
}

export class Task {
  readonly table:     BitmexTable;
  readonly date:      string;
  readonly type:      'ws' | 'rest';
  readonly startTime: number;

  /** Set by the reader on stream end. `null` until then. */
  totalMessages:  number | null;
  /** Shared service-level stop flag; pipeline stages check it via `item.task.stopSignal`. */
  readonly stopSignal: StopSignal;

  /** Items admitted into the write pipeline that haven't yet been confirmed by mongo. */
  pending: number;

  private readonly timer:      NodeJS.Timeout;
  private readonly onComplete?: (task: Task) => void;

  /** Next position expected to advance the contiguous-confirmed frontier. `messages = nextExpected - 1`. */
  private nextExpected:  number;
  /** Disposed positions waiting for the frontier to catch up. Drained when `nextExpected` reaches them. */
  private disposedAhead: Set<number>;

  private finished: boolean = false;

  constructor(opts: TaskOptions) {
    this.table         = opts.table;
    this.date          = opts.date;
    this.type          = WS_TABLES.has(opts.table) ? 'ws' : 'rest';
    this.totalMessages = null;
    this.startTime     = Date.now();
    this.stopSignal    = opts.stopSignal;
    this.onComplete    = opts.onComplete;

    this.pending       = 0;
    this.nextExpected  = opts.skip + 1;
    this.disposedAhead = new Set();

    this.timer = setInterval(() => { void this.tick(); }, opts.intervalMs);
    this.timer.unref();
  }

  /** Contiguous-confirmed frontier. Safe resume point: positions 1..messages are accounted for. */
  get messages(): number {
    return this.nextExpected - 1;
  }

  /** Called by infer/assemble when an item enters the write pipeline (one per item). */
  admit(): void {
    this.pending++;
  }

  /**
   * Called once per item after it has been disposed of:
   *   - `viaWrite = true`  → mongo confirmed the insert (or treated a dupe as success)
   *   - `viaWrite = false` → assemble dropped it (parse fail, reconstruct fail, empty data)
   *
   * Drops never went through the inflight gate, so they don't touch `pending`.
   * Confirms came through admit/inflight, so they decrement.
   *
   * The position is recorded against the frontier in either case so that
   * `messages` only advances across a gap-free prefix.
   */
  noteDisposed(position: number, viaWrite: boolean): void {
    if (viaWrite) this.pending--;

    if (position === this.nextExpected) {
      this.nextExpected++;

      while (this.disposedAhead.has(this.nextExpected)) {
        this.disposedAhead.delete(this.nextExpected);
        this.nextExpected++;
      }
    } else if (position > this.nextExpected) {
      this.disposedAhead.add(position);
    }

    this.checkDone();
  }

  /** Called by the reader once vault has emitted the bucket's last line. */
  setTotalMessages(count: number): void {
    this.totalMessages = count;

    this.checkDone();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private checkDone(): void {
    if (this.finished)               return;
    if (this.totalMessages === null) return;
    if (this.pending > 0)            return;
    if (this.messages < this.totalMessages) return;

    void this.finish();
  }

  private async tick(): Promise<void> {
    if (this.finished)             return;
    if (this.stopSignal.triggered) return;

    try {
      await markProgress(this.table, this.date, this.messages);
    } catch (err) {
      logger.warn({ err, table: this.table, date: this.date }, 'Task progress tick failed');
    }
  }

  private async finish(): Promise<void> {
    if (this.finished) return;

    this.finished = true;
    clearInterval(this.timer);

    try {
      await markDone(this.table, this.date, this.messages);
      logger.info({ table: this.table, date: this.date, messages: this.messages }, 'Task complete');
    } catch (err) {
      logger.error({ err, table: this.table, date: this.date }, 'Task finalize failed');
    }

    if (this.onComplete) this.onComplete(this);
  }
}
