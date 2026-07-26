import type { WsServerHandle } from '@devvir/service-kit';
import * as clock from '../core/clock';
import * as snapshot from '../core/snapshot';
import { fanout } from './egress';
import type { Reader } from '../reader';
import type { Pacer } from './pacer';

/**
 * The streaming loop — the heart of digger. Each turn: gate on the pacer, then
 * drain a **batch** of messages from the merge (fan out, feed the accumulator,
 * advance the clock, top up the buffer), and yield once. Batching amortises the
 * `setImmediate` yield and the pacer scan over many messages — back-pressure
 * stays responsive because the overshoot (one batch of small delta messages) is
 * far below the MB-scale `bufferedAmount` threshold. The yield still lets sockets
 * flush and provider fetches run between batches, which is what keeps
 * `bufferedAmount` (and therefore the pacer) honest.
 *
 * It never breaks: with no subscriptions it idles (time frozen); when replay runs
 * out it idles too, ready for a seek.
 */

const IDLE_MS  = 50;   // nothing subscribed
const PACE_MS  = 5;    // gated by a slow client
const EMPTY_MS = 5;    // buffers momentarily empty while fetching

const sleep     = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const immediate = (): Promise<void> => new Promise(r => setImmediate(r));

export class Loop {
  paused = false;

  #running = false;

  constructor(
    private readonly server:     WsServerHandle,
    private readonly reader:     Reader,
    private readonly pacer:      Pacer,
    private readonly drainBatch: number,
  ) {}

  start(): void {
    if (this.#running) return;

    this.#running = true;
    void this.#run();
  }

  stop(): void {
    this.#running = false;
  }

  async #run(): Promise<void> {
    while (this.#running) {
      if (this.paused || ! this.reader.anyActive()) { await sleep(IDLE_MS); continue; }
      if (! this.pacer.mayEmit())                   { await sleep(PACE_MS); continue; }

      const emitted = this.#drainBatch();

      if (emitted === 0) { await sleep(EMPTY_MS); continue; }

      await immediate();   // one yield per batch — sockets flush, fetches run
    }
  }

  /** Emit up to `drainBatch` merged messages; return how many went out. */
  #drainBatch(): number {
    let emitted = 0;

    while (emitted < this.drainBatch) {
      const item = this.reader.next();

      if (! item) break;

      fanout(this.server, item);

      /** Feed every message to the accumulator — the library maintains each
       *  table's correct snapshot and already ignores the empty-partial tables. */
      snapshot.feed(item.msg);

      clock.update(item.ts);
      this.reader.refill(item.msg.table);

      emitted++;
    }

    return emitted;
  }
}
