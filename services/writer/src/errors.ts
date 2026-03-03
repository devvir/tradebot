import type { Collection } from 'mongodb';
import { MongoBulkWriteError, MongoError } from 'mongodb';
import { logger } from '@devvir/service';
import type { BatchEntry, ErrorContext } from './types';

const DUPLICATE_KEY_ERROR_CODE = 11_000;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Handle a failed insertMany call.
 *
 * Two branches:
 *   1. MongoBulkWriteError (partial failure) — some docs may have been inserted.
 *      Inspect writeErrors to ACK the ones that went through and individually
 *      settle each failure.
 *   2. Any other error (network / auth / unexpected) — nothing was inserted.
 *      Fall back to one-by-one insertOne to isolate the bad message(s).
 *
 * Poison-pill protection: if a message has already been redelivered and still
 * fails, it is dead-lettered instead of requeued, preventing infinite loops.
 */
export async function handleBatchError(
  error: unknown,
  entries: BatchEntry[],
  collection: Collection,
  onStoreMsg: () => void,
  ctx: ErrorContext,
): Promise<void> {
  if (error instanceof MongoBulkWriteError) {
    handlePartialFailure(error, entries, onStoreMsg, ctx);
  } else {
    await handleTotalFailure(entries, collection, onStoreMsg, ctx);
  }
}

// ── Partial failure (MongoBulkWriteError) ────────────────────────────────────

/**
 * insertMany({ordered:false}) tried every document.  writeErrors tells us
 * which indices failed.  Everything else was inserted successfully.
 */
function handlePartialFailure(
  error: MongoBulkWriteError,
  entries: BatchEntry[],
  onStoreMsg: () => void,
  ctx: ErrorContext,
): void {
  const failedIndices = new Map<number, { code: number; errmsg?: string }>();
  const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];

  for (const we of writeErrors) {
    failedIndices.set(we.index, { code: we.code, errmsg: we.errmsg });
  }

  let acked = 0;
  let nacked = 0;
  let deadLettered = 0;

  for (let i = 0; i < entries.length; i++) {
    const failure = failedIndices.get(i);

    if (! failure || isDuplicateKeyError(failure.code)) {
      entries[i].event.ack();
      onStoreMsg();
      acked++;
      continue;
    }

    const stats = settleFailedEntry(entries[i], ctx, failure.errmsg);
    nacked += stats.nacked;
    deadLettered += stats.deadLettered;
  }

  logger.info(
    { collection: ctx.collection, queue: ctx.queue, acked, nacked, deadLettered, writeErrors: failedIndices.size },
    'insertMany partial failure — settled individually',
  );
}

// ── Total failure (network / auth / unexpected) ──────────────────────────────

/**
 * The insertMany call itself failed with a non-bulk error (e.g. network timeout,
 * auth failure).  Nothing was inserted.
 *
 * Falls back to one-by-one insertOne to ACK the docs that succeed
 * and isolate the ones that don't.
 */
async function handleTotalFailure(
  entries: BatchEntry[],
  collection: Collection,
  onStoreMsg: () => void,
  ctx: ErrorContext,
): Promise<void> {
  logger.info(
    { collection: ctx.collection, queue: ctx.queue, count: entries.length },
    'insertMany total failure — falling back to individual insertOne',
  );

  let acked = 0;
  let nacked = 0;
  let deadLettered = 0;

  for (const entry of entries) {
    try {
      await collection.insertOne(entry.document);
      entry.event.ack();
      onStoreMsg();
      acked++;
    } catch (e) {
      if (e instanceof MongoError && isDuplicateKeyError(e.code)) {
        entry.event.ack();
        onStoreMsg();
        acked++;
        continue;
      }

      const errmsg = e instanceof Error ? e.message : String(e);
      const stats = settleFailedEntry(entry, ctx, errmsg);
      nacked += stats.nacked;
      deadLettered += stats.deadLettered;
    }
  }

  logger.info(
    { collection: ctx.collection, queue: ctx.queue, acked, nacked, deadLettered },
    'insertOne fallback complete',
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decide the fate of a single message that could not be inserted.
 *
 * Poison-pill protection: if the message was already redelivered once and is
 * still failing, it is dead-lettered (nack without requeue) so it doesn't
 * loop forever.  Fresh messages get one more chance via requeue.
 */
function settleFailedEntry(
  entry: BatchEntry,
  ctx: ErrorContext,
  errmsg?: string,
): { nacked: number; deadLettered: number } {
  const { redelivered, routingKey } = entry.event.metadata;

  if (redelivered) {
    logger.error(
      { routingKey, queue: ctx.queue, errmsg },
      'Redelivered message failed again — dead-lettering',
    );
    entry.event.nack(false);
    return { nacked: 0, deadLettered: 1 };
  }

  logger.debug(
    { routingKey, queue: ctx.queue, errmsg },
    'Message insert failed — requeueing (first attempt)',
  );
  entry.event.nack(true);

  return { nacked: 1, deadLettered: 0 };
}

function isDuplicateKeyError(code: string | number | undefined): boolean {
  return code === DUPLICATE_KEY_ERROR_CODE;
}
