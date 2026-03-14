import { BitmexAction, BitmexTable } from '@tradebot/types';
import { logger } from '@devvir/service-kit';
import { mapGet } from '@tradebot/utils';
import { Document } from 'mongodb';
import { pause, resume } from './semaphore';

/**
 * Each ID must be unique within a given table + action + millisecond (from
 * the timestamp associated with the document reception, upstream or here if
 * upstream didn't provide one).
 *
 * The discriminator is an incremental 10 bit number shared among all writer
 * instances, with each instance reserving its own partition, settled through
 * trial and error (decoupled orchestration): if a collision occurs on insert,
 * the instance moves to the next partition and tries again after a random delay.
 *
 * Discriminator zero is excluded, since it would lead to the same ID for all
 * instances (since the default value for non-owned partitions is zero as well).
 *
 * As long as the number of Writer instances does not exceed MAX_WRITER_INSTANCES,
 * a stable distribution is eventually guaranteed.
 */

type TsCounter = { count: number; };
type CacheList = Map<number, TsCounter>;
type CacheSlot = Map<string, CacheList>;

/**
 * In-memory store, keeps track of number of documents processed for each timestamp (ms), table
 * and action combination. Top level is the slot, one per second, for easy stale data disposal.
 *
 * Nested structure: seconds slot > table+action > timestamp (ms) > { count: number }
 */
const CACHE = new Map<number, CacheSlot>();

/**
 * How many distinct second-based slots to keep in memory at any given time.
 */
const CACHE_SLOTS = 10;

/**
 * The max number of Writer instances determines the max size of the discriminator partitions.
 */
const MAX_WRITER_INSTANCES = 4;

/**
 * Max number of ids allowed within this instance's discriminator's partition, per ms slot.
 */
const IDS_PER_MS = Math.floor(512 / MAX_WRITER_INSTANCES);

/**
 * Mapping from BitmexAction to 0-3 code, embedded in all generated IDs.
 */
export const ACTION_ID: Record<BitmexAction, 0 | 1 | 2 | 3> = { partial: 0, insert: 1, update: 2, delete: 3 };

/**
 * Current instance's reserved slot (defines discriminator partition for globally unique IDs).
 *
 * On insert collisions, Writer assumes another instance is sharing the partition, and moves
 * to the next slot in a cycle, with random pauses, until all instances find the right spot
 * (guaranteed to eventually happen as long as #instances <= MAX_WRITER_INSTANCES).
 */
let instanceSlot = 0;

/**
 * Keep track of the last cache slot, to clear stale slots when we move to a new one.
 * Only advance forward — never clear based on out-of-order messages from concurrent producers.
 */
let lastCacheSlot = 0;
let maxSeenTsMs = 0;

/**
 * Generate a unique ID for a document.
 *
 * Uniqueness is only guaranteed within a 10s window and within this instance. Collisions
 * may still happen when attempting to persist, and those are handled in ./duplicates.ts.
 *
 * ID: ts (41 bits) | reserved (1 bit) | discriminator (9 bits) | action (2 bits)
 * NOTE: The `reserved` bit is used for "emergency mode" (see ./duplicates.ts)
 */
export default function generateId(doc: Document, tsMs: number): number {
  const table = doc.table as BitmexTable;
  const action = doc.action as BitmexAction;
  const cacheSlot = Math.floor(tsMs / 1000) % CACHE_SLOTS;

  // Clear old state (skip immediate next slot in case we overflowed into it).
  // Only advance on monotonically increasing timestamps — non-monotonic messages from
  // concurrent codec instances must not clear slots that are still actively in use.
  if (tsMs > maxSeenTsMs) {
    maxSeenTsMs = tsMs;
    if (cacheSlot !== lastCacheSlot) {
      lastCacheSlot = cacheSlot;
      const staleSlotKey = (cacheSlot + 2) % CACHE_SLOTS;
      mapGet(CACHE, staleSlotKey, new Map()).clear();
    }
  }

  const slotMap = mapGet<CacheSlot>(CACHE, cacheSlot, new Map());
  const listMap = mapGet<CacheList>(slotMap, `${table}.${action}`, new Map());
  const tsCounter = mapGet<TsCounter>(listMap, tsMs, { count: 0 });

  // The counter indicates how many documents have fallen in the current tsMs' slot
  tsCounter.count++;

  // Overflows are handled by borrowing from cache for future timestamps
  if (tsCounter.count > IDS_PER_MS) return generateId(doc, tsMs + 1);

  // Map tsCounter to this instance's partition in the shared discriminator space
  const discriminator = tsCounter.count + (instanceSlot * IDS_PER_MS) - 1;
  const timestampSlot = Number((BigInt(tsMs) & 0x1FFFFFFFFFFn) << 12n);

  // ID: ts (41 bits) | reserved (1 bit) | discriminator (9 bits) | action (2 bits)
  return timestampSlot + (discriminator * 4) + ACTION_ID[action as BitmexAction];
}

/**
 * Advance to the next instance slot (circular) after a brief delay.
 */
export function moveToNextSlot(): void {
  const previous = instanceSlot;
  const delayMs = 2000 + Math.floor(Math.random() * 5000);

  instanceSlot = (instanceSlot + 1) % MAX_WRITER_INSTANCES;

  logger.warn({ previous, next: instanceSlot, delayMs }, 'Duplicate-key collision detected — rotating partition slot');

  pause(delayMs);
}

/**
 * Test helpers for setup/teardown.
 */
export const _clearCacheSlot = (tsMs: number) => CACHE.get(Math.floor(tsMs / 1000) % CACHE_SLOTS)?.clear();
export const _getInstanceSlot = () => instanceSlot;
export const _resetInstanceSlot = () => ( instanceSlot = 0, lastCacheSlot = 0, maxSeenTsMs = 0, resume() );
