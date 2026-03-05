import { logger } from '@devvir/service';

const BUCKET_COUNT = 10;
const SLOT_RETRY_AFTER_MS = 5000;

export const EPOCH_2000_MS = 946_684_800_000;

export const ACTION_ID = { partial: 0, insert: 1, update: 2, delete: 3 } as const;
export type BitmexAction = keyof typeof ACTION_ID;

// buckets[slot]: Map<`${table}.${action}.${tsMs}`, lastLocalCounter>
const buckets: Map<string, number>[] = Array.from({ length: BUCKET_COUNT }, () => new Map());

/**
 * Generate a unique, sortable _id for a message received by the writer.
 *
 * Layout: tsMs(41) | discriminator(10) | action(2) = 53 bits
 *
 * - tsMs: milliseconds since 2000-01-01T00:00:00Z
 * - discriminator: `(currentSlot * 256) + localCounter`, where localCounter
 *   is a 0-indexed counter per (table, action, tsMs) tuple within this slot's
 *   partition. Overflows (localCounter >= 256) spill into the next millisecond.
 * - action: 2-bit encoding of partial(0) / insert(1) / update(2) / delete(3)
 */
export function generateId(table: string, action: BitmexAction, tsMs: number): number {
  const slot = Math.floor(tsMs / 1000) % BUCKET_COUNT;
  const bucket = buckets[slot];
  const key = `${table}.${action}.${tsMs}`;

  const existing = bucket.get(key);
  let localCounter: number;

  if (existing === undefined) {
    localCounter = 0;
    bucket.set(key, 0);
  } else {
    localCounter = existing + 1;
    bucket.set(key, localCounter);
  }

  const discriminator = currentSlot * PARTITION_SIZE + localCounter;

  // Overflow: localCounter >= PARTITION_SIZE spills into tsMs+1 (timestamp bits).
  // Seed the next-ms bucket to prevent future collisions there.
  if (localCounter >= PARTITION_SIZE) {
    const overflowCounter = localCounter - PARTITION_SIZE;
    const nextKey = `${table}.${action}.${tsMs + 1}`;
    const nextSlot = Math.floor((tsMs + 1) / 1000) % BUCKET_COUNT;
    buckets[nextSlot].set(nextKey, overflowCounter);

    const overflowDiscriminator = currentSlot * PARTITION_SIZE + overflowCounter;
    return (tsMs + 1) * 4096 + overflowDiscriminator * 4 + ACTION_ID[action];
  }

  return tsMs * 4096 + discriminator * 4 + ACTION_ID[action];
}

// Every second, clear the bucket slot about to be reused (~10s rolling window).
setInterval(() => {
  const nextSlot = (Math.floor((Date.now() - EPOCH_2000_MS) / 1000) + 1) % BUCKET_COUNT;
  buckets[nextSlot].clear();
}, 1000).unref();

/** @internal Clear a specific bucket slot by tsMs. Used in tests only. */
export function _clearSlot(tsMs: number): void {
  buckets[Math.floor(tsMs / 1000) % BUCKET_COUNT].clear();
}

/** @internal Reset slot to 0. Used in tests only. */
export function _resetSlot(): void {
  currentSlot = 0;
  pausePromise = null;
}

// ── Slot partitioning ────────────────────────────────────────────────────────
//
// The 10-bit discriminator (0–1023) is divided into 4 partitions of 256 each.
// Each writer instance occupies one slot so that multiple instances consuming
// from the same queue never generate colliding _ids.

const SLOT_COUNT = 4;
const PARTITION_SIZE = 256;

let currentSlot = 0;
let pausePromise: Promise<void> | null = null;

/** Advance to the next partition (circular) and pause briefly. */
export function moveToNextSlot(): void {
  const previous = currentSlot;
  currentSlot = (currentSlot + 1) % SLOT_COUNT;

  const delayMs = 2000 + Math.floor(Math.random() * SLOT_RETRY_AFTER_MS); // Wait 2000 to SLOT_RETRY_AFER_MS ms
  logger.warn({ previousSlot: previous, newSlot: currentSlot, delayMs }, 'Duplicate-key collision detected — rotating partition slot');

  pausePromise = new Promise<void>(resolve => {
    setTimeout(() => {
      pausePromise = null;
      resolve();
    }, delayMs);
  });
}

/** Returns the active pause promise, or null if not paused. */
export function pauseConsumer(): Promise<void> | null {
  return pausePromise;
}

/** Returns the current slot (for testing / logging). */
export function getSlot(): number {
  return currentSlot;
}
