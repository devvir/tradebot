/**
 * Duplicate-key collision handling for the writer service.
 *
 * When MongoDB rejects an insert with error 11000 (duplicate key), we can't just nack: another
 * instance may be in the same discriminator partition and will keep writing the same IDs. We need
 * to distinguish two very different root causes and respond accordingly:
 *
 *   Stale cache (restart):  this instance's CACHE was wiped, so it regenerated IDs that the
 *                           previous run already wrote. Self-correcting — collisions stop once the
 *                           CACHE_SLOTS window (~10 s) catches up. No slot switch needed.
 *
 *   Live competition:       another instance is actively writing into the same discriminator
 *                           partition right now. Collisions will persist until one instance moves.
 *
 * Two triggers determine when to call moveToNextSlot():
 *
 *   Trigger 1 — Stream-relative timestamp (primary, latent):
 *     We sample the first 1000 document timestamps to establish "streamPresent" — a proxy for
 *     where the stream currently is in time. Any duplicate on a document with a LATER timestamp
 *     (and retries === 0 && !redelivered) cannot be our own stale cache: we never wrote that data
 *     before. It must be another live instance. After 20 such observations, we switch.
 *     Note: retries > 0 and redelivered are excluded because emergency IDs (retries > 0) are not
 *     CACHE-tracked and can collide within a single instance; redelivered messages are not fresh
 *     signals.
 *
 *   Trigger 2 — Exhaustion (last resort):
 *     If entries keep getting dead-lettered (all 5 retries exhausted) across 1000 separate batches,
 *     something is systematically wrong regardless of timestamp evidence. Rotate unconditionally.
 *     This covers archive processing, large queue backlogs, or any scenario where Trigger 1 is
 *     unable to distinguish old-timestamp live competition.
 *
 * Entries that exhaust MAX_RETRIES are nacked with requeue=true on first delivery (leveraging the
 * 512 emergency discriminators as a safety net), and dead-lettered only on redelivery.
 */

import { Collection, Document as MongoDocument } from "mongodb";
import { BatchEntry, Document } from "./types";
import { logger } from "@devvir/service";
import { addToBatch } from "./batch";
import { ConsumerEvent } from "@devvir/rabbitmq";
import { moveToNextSlot } from "./documentId";

const MAX_RETRIES = 5;

// ── Trigger 1: stream-relative timestamp ──────────────────────────────────────

const SAMPLE_SIZE = 1000;
const LIVE_COLLISION_THRESHOLD = 20;

let sampledCount = 0;
let streamPresent = 0;
let liveCollisions = 0;

export const sampleTimestamp = (tsMs: number): void => {
  sampledCount++;
  if (tsMs > streamPresent) streamPresent = tsMs;
};

const detectLiveCollision = (entries: BatchEntry[]): void => {
  if (sampledCount < SAMPLE_SIZE) return;

  const hasLiveEvidence = entries.some(e =>
    e.retries === 0 &&
    ! e.metadata.redelivered &&
    Math.floor(e.document._id / 4096) > streamPresent
  );

  if (! hasLiveEvidence) return;

  liveCollisions++;

  if (liveCollisions >= LIVE_COLLISION_THRESHOLD) {
    liveCollisions = 0;
    logger.warn({ threshold: LIVE_COLLISION_THRESHOLD }, 'Switching slot: live competition detected via timestamp');
    moveToNextSlot();
  }
};

// ── Trigger 2: exhaustion fallback ────────────────────────────────────────────

const EXHAUSTION_THRESHOLD = 1000;

let unavoidableCollisions = 0;

const considerExhaustionSwitch = (): void => {
  unavoidableCollisions++;

  if (unavoidableCollisions > EXHAUSTION_THRESHOLD) {
    unavoidableCollisions = 0;
    logger.warn({ threshold: EXHAUSTION_THRESHOLD }, 'Switching slot: exhaustion fallback');
    moveToNextSlot();
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a random cycling sequence of emergency discriminators, to minimize repeated
 * collisions with other instances performing the same procedure to find available IDs.
 */
const instanceRetryCycle = Array.from({ length: 512 }, (_, i) => i).sort(() => Math.random() - 0.5);

export const handleDuplicates = (db: Collection<MongoDocument>, entries: BatchEntry[]) => {
  logger.warn({ count: entries.length }, 'Handling duplicate-key collisions');

  detectLiveCollision(entries); // must run before requeueDuplicates mutates _id

  if (requeueDuplicates(db, entries)) considerExhaustionSwitch();
};

/**
 * Requeue documents failed with Duplicate Key error from Mongo, up to MAX_RETRIES.
 * Returns true if any entry was dead-lettered (retries exhausted).
 */
const requeueDuplicates = (db: Collection<MongoDocument>, entries: BatchEntry[]): boolean => {
  let exhausted = false;

  entries.forEach(({ document, ack, nack, metadata, retries }, i) => {
    document._id += 0x800 + instanceRetryCycle[i % instanceRetryCycle.length];
    document.table = db.collectionName;

    if (retries < MAX_RETRIES) {
      addToBatch(db.dbName, document as Document, { ack, nack, metadata } as ConsumerEvent, retries + 1);
    } else {
      nack(! metadata.redelivered);
      exhausted = true;

      const { table, action, data, b, ...doc } = document;
      logger.error({ doc, retries }, `Failed to store document after ${MAX_RETRIES} retries: skipping`);
    }
  });

  return exhausted;
};

// ── Test helpers ──────────────────────────────────────────────────────────────

/** @internal Tests only */
export const _resetDuplicatesState = (): void => {
  sampledCount = 0;
  streamPresent = 0;
  liveCollisions = 0;
  unavoidableCollisions = 0;
};
