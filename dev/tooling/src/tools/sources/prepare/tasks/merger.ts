import { debug } from '../../../../shared/ui/logger';
import { potentialGapThresholdMs } from '../../tables';
import type { PreparedMessage } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * MERGE — N-way gap-aware merge.
 *
 * Stays on the highest-priority active source as long as its next message
 * falls within `gapThreshold` ms of the last emitted message. When a gap is
 * detected (or the source is exhausted), advance every other source past the
 * already-covered range (drop its messages there — they are duplicates of
 * what the higher source already provided), then switch to the
 * highest-priority source whose head is at or beyond `nextMs`.
 *
 * Priority is index order: index 0 is the highest. The orchestrator passes
 * sources in alphabetical (filename) order.
 *
 * Sources are already sorted by `ts` upstream (SORT). This step does not
 * re-sort.
 */
export async function* merge(
  sources:   AsyncGenerator<PreparedMessage[]>[],
  tableName: string,
): AsyncGenerator<PreparedMessage[]> {
  if (sources.length === 0) {
    return;
  }

  const gapThreshold = potentialGapThresholdMs(tableName);
  const batchSize    = 10_000;
  const peekables    = sources.map(s => new Peekable(s));
  const batch:       PreparedMessage[] = [];
  let   batchN     = 0;
  let   totalMerged = 0;

  // ── Pick initial source: lowest head tsMs, priority breaks ties ──────────
  let activeIdx = -1;
  let activeMs  = Infinity;

  for (let i = 0; i < peekables.length; i++) {
    const head = await peekables[i]!.peek();

    if (head !== null && head.tsMs < activeMs) {
      activeIdx = i;
      activeMs  = head.tsMs;
    }
  }

  if (activeIdx === -1) {
    return; // all sources empty
  }

  // ── N-way walk ──────────────────────────────────────────────────────────
  while (true) {
    const message = await peekables[activeIdx]!.pop();

    if (message === null) {
      break; // active source exhausted with no fallback (shouldn't happen here)
    }

    batch.push(message);

    if (batch.length >= batchSize) {
      batchN++;
      totalMerged += batch.length;
      plog(`[MERGE] batch ${batchN}: ${batch.length} msgs | total: ${totalMerged}`);
      yield batch.splice(0);
    }

    const nextMs = message.tsMs + gapThreshold;

    // Stay on the current source if its next message is within range.
    const currentHead = await peekables[activeIdx]!.peek();

    if (currentHead !== null && currentHead.tsMs <= nextMs) {
      continue;
    }

    // Switch. First, drain messages from every source whose head falls at or
    // before `message.tsMs` — those are covered by what the active source
    // already emitted and would be duplicates. Messages AFTER `message.tsMs`
    // are gap-fillers and must be kept. Then select the source with the
    // lowest remaining head; priority breaks ties.
    for (const p of peekables) {
      let head = await p.peek();

      while (head !== null && head.tsMs <= message.tsMs) {
        await p.pop();
        head = await p.peek();
      }
    }

    let nextActive = -1;
    let lowestMs   = Infinity;

    for (let i = 0; i < peekables.length; i++) {
      const head = await peekables[i]!.peek();

      if (head !== null && head.tsMs < lowestMs) {
        lowestMs   = head.tsMs;
        nextActive = i;
      }
    }

    if (nextActive === -1) {
      break; // all sources exhausted
    }

    activeIdx = nextActive;
  }

  if (batch.length > 0) {
    batchN++;
    totalMerged += batch.length;
    plog(`[MERGE] batch ${batchN} (final): ${batch.length} msgs | total: ${totalMerged}`);
    yield batch;
  }

  plog(`[MERGE] done — ${batchN} batches, ${totalMerged} msgs total`);
}

/**
 * One-message lookahead adapter over an `AsyncGenerator<PreparedMessage[]>`.
 *
 * `peek()` returns the head without consuming; `pop()` returns and consumes.
 * Holds at most one batch worth of buffered messages — refills lazily when
 * the current batch is exhausted.
 */
export class Peekable {
  private current: PreparedMessage[] = [];
  private idx:     number             = 0;
  private done:    boolean            = false;

  constructor(private readonly source: AsyncGenerator<PreparedMessage[]>) {}

  async peek(): Promise<PreparedMessage | null> {
    while (this.idx >= this.current.length) {
      if (this.done) {
        return null;
      }

      const next = await this.source.next();

      if (next.done) {
        this.done    = true;
        this.current = [];
        this.idx     = 0;

        return null;
      }

      this.current = next.value;
      this.idx     = 0;
    }

    return this.current[this.idx]!;
  }

  async pop(): Promise<PreparedMessage | null> {
    const head = await this.peek();

    if (head !== null) {
      this.idx++;
    }

    return head;
  }
}
