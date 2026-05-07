import { debug } from '../../../../shared/ui/logger';
import { potentialGapThresholdMs } from '../../tables';
import type { PreparedMessage } from '../types';

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * N-way gap-aware merge across sorted sources. Stays on the highest-priority
 * source as long as its next message is within `gapThreshold` ms of the last
 * emitted; on a gap, drains every other source past the already-covered range
 * (those would be duplicates) and switches to the next available source.
 * Priority is index order — index 0 wins ties.
 */
export async function* merge(
  sources:    AsyncGenerator<PreparedMessage[]>[],
  tableName:  string,
  onComplete: (contributedBySource: number[]) => void = () => { /* no-op */ },
): AsyncGenerator<PreparedMessage[]> {
  if (sources.length === 0) return;

  const gapThreshold        = potentialGapThresholdMs(tableName);
  const batchSize           = 10_000;
  const peekables           = sources.map(s => new Peekable(s));
  const contributedBySource = sources.map(() => 0);
  const batch:       PreparedMessage[] = [];
  let   batchN     = 0;
  let   totalMerged = 0;

  // Initial source: lowest head tsMs; priority breaks ties.
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
    onComplete(contributedBySource);

    return; // all sources empty
  }

  while (true) {
    const message = await peekables[activeIdx]!.pop();

    if (message === null) break;

    batch.push(message);
    contributedBySource[activeIdx]!++;

    if (batch.length >= batchSize) {
      batchN++;
      totalMerged += batch.length;
      plog(`[MERGE] batch ${batchN}: ${batch.length} msgs | total: ${totalMerged}`);
      yield batch.splice(0);
    }

    const nextMs = message.tsMs + gapThreshold;

    const currentHead = await peekables[activeIdx]!.peek();

    if (currentHead !== null && currentHead.tsMs <= nextMs) continue;

    // Gap: drop already-covered messages from every other source (heads <=
    // current ts are duplicates of what we just emitted), then jump to the
    // next available source.
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

    if (nextActive === -1) break;

    activeIdx = nextActive;
  }

  if (batch.length > 0) {
    batchN++;
    totalMerged += batch.length;
    plog(`[MERGE] batch ${batchN} (final): ${batch.length} msgs | total: ${totalMerged}`);
    yield batch;
  }

  plog(`[MERGE] done — ${batchN} batches, ${totalMerged} msgs total`);
  onComplete(contributedBySource);
}

/**
 * One-message lookahead over a batched async generator. Refills lazily one
 * batch at a time.
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
