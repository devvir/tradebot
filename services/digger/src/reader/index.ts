import { logger } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import * as snapshot from '../core/snapshot';
import type { Provider } from '../provider';
import type { Config } from '../types';
import type { WsMessage, StreamItem } from '../core/types';
import { createBuffer, enqueue, needsRefetch } from './buffer';
import { pickNext, allExhausted } from './merge';
import type { TableBuffer } from './types';

/**
 * The data plane: warm per-table buffers fed by paging the provider, drained by
 * the k-way merge. No shaping and no per-table knowledge — messages arrive ready,
 * and partials come straight from the accumulator (`@devvir/bitmex-database`),
 * which produces the correct snapshot for every table kind (full / 1-per-symbol /
 * active / empty). The reader's only job around partials is to *prime* the
 * accumulator: feed the provider's partial (a table is only tracked once it has
 * had a partial), catch up deltas to the clock, then read `buildPartial`.
 */
export class Reader {
  /** Live buffers — drained by the merge. */
  private readonly buffers = new Map<BitmexTable, TableBuffer>();
  /** Buffers built by `activate` but not yet loop-visible — see `promote`. */
  private readonly staged  = new Map<BitmexTable, TableBuffer>();

  constructor(private readonly provider: Provider, private readonly config: Config) {}

  // ── Membership ──────────────────────────────────────────────────────────────

  isActive(table: BitmexTable): boolean { return this.buffers.has(table); }
  anyActive(): boolean { return this.buffers.size > 0; }

  /** The partial to send a *warm* subscriber — current state from the accumulator. */
  partialFor(table: BitmexTable): WsMessage | null {
    return snapshot.buildPartial(table);
  }

  // ── Activation ──────────────────────────────────────────────────────────────

  /**
   * Cold-activate a table at `atClock`; returns the partial to send the new
   * client. Uniform for every table: feed the provider's partial to create the
   * table in the accumulator, catch up the deltas/inserts before the clock, then
   * read the resulting snapshot. How far back priming starts is the provider's
   * call (its cursor) — digger carries no per-table partial logic.
   */
  async activate(table: BitmexTable, atClock: number): Promise<WsMessage | null> {
    if (this.buffers.has(table)) return snapshot.buildPartial(table);

    const { partial, cursor } = await this.provider.partial(table, atClock);

    const buffer = createBuffer(table);
    buffer.cursor = cursor;
    this.staged.set(table, buffer);

    /** The creating partial — without it the library ignores subsequent deltas. */
    if (partial) snapshot.feed(partial);

    await this.catchUp(buffer, atClock);

    return snapshot.buildPartial(table) ?? partial;
  }

  /**
   * Make a staged buffer loop-visible. Called synchronously by the hub *after* the
   * client's partial is sent, so the merge never emits a delta before the partial.
   */
  promote(table: BitmexTable): void {
    const buffer = this.staged.get(table);

    if (! buffer) return;

    this.staged.delete(table);
    this.buffers.set(table, buffer);
  }

  /** Drop a table's buffer (last unsubscribe). */
  deactivate(table: BitmexTable): void {
    this.buffers.delete(table);
    this.staged.delete(table);
  }

  /** Reset on a clock seek — drop every buffer; priming happens on next activate. */
  clear(): void {
    this.buffers.clear();
    this.staged.clear();
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /** The next message in global chronological order, or null when none is ready. */
  next(): StreamItem | null {
    const pick = pickNext(this.buffers);

    if (! pick) return null;

    return pick.buffer.entries.shift() ?? null;
  }

  /** Background refill of a table that has fallen below the low-watermark. */
  refill(table: BitmexTable): void {
    const buffer = this.buffers.get(table);

    if (! buffer || ! needsRefetch(buffer, this.config.lowWatermark)) return;

    this.fill(buffer).catch(err => {
      logger.error({ err, table }, 'Reader refill failed');
      buffer.isFetching = false;
    });
  }

  /** True when buffers exist but all are drained with no more upstream (replay ended). */
  exhaustedAndEmpty(): boolean {
    return this.buffers.size > 0 && allExhausted(this.buffers);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async fill(buffer: TableBuffer): Promise<void> {
    if (buffer.cursor === null || buffer.isFetching || buffer.exhausted) return;

    buffer.isFetching = true;

    const page = await this.provider.stream(buffer.table, buffer.cursor, this.config.batchSize);

    enqueue(buffer, page.messages);
    buffer.cursor     = page.cursor;
    buffer.exhausted  = page.exhausted;
    buffer.isFetching = false;
  }

  /**
   * Page forward from the stored partial, folding every message with `ts < atClock`
   * into the accumulator (silent catch-up). The first message with `ts >= atClock`
   * and all after it land in the buffer for emission.
   */
  private async catchUp(buffer: TableBuffer, atClock: number): Promise<void> {
    while (buffer.cursor !== null && ! buffer.exhausted) {
      const page = await this.provider.stream(buffer.table, buffer.cursor, this.config.batchSize);

      buffer.cursor    = page.cursor;
      buffer.exhausted = page.exhausted;

      for (let i = 0; i < page.messages.length; i++) {
        const item = page.messages[i]!;

        if (item.ts < atClock) {
          snapshot.feed(item.msg);
        } else {
          enqueue(buffer, page.messages.slice(i));

          return;
        }
      }

      if (page.messages.length === 0) return;
    }
  }
}
