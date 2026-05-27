/**
 * Per-table batch flusher.
 *
 * Runs on a periodic timer. Each tick walks `batches` and starts as many
 * HTTP POSTs to the writer service as fit under the wire-side byte cap.
 * Multiple concurrent posts per table are allowed (each fetch runs in its
 * own async branch). Items hand off from the writer-queue inflight gate
 * (`release`) to the wire-side counter (`wireBytes`) at splice time; the
 * writer queue reopens for the next round immediately.
 *
 * Batching is bounded by **bytes** (`item.size`), not item count. A
 * single WS partial may carry tens of thousands of rows and run to MBs
 * on its own, so a per-item or per-row cap can easily blow past the
 * writer's body limit. `MAX_BYTES_PER_REQUEST` caps each POST body.
 * Edge case: when the very first item in a batch already exceeds the
 * cap (e.g. a huge orderBookL2 partial), it ships alone — the writer
 * will either accept it (mongo's per-doc 16 MB limit permitting) or
 * surface an error that the retry loop catches.
 *
 * Confirmations come back as HTTP responses. Each item routes through
 * `task.noteDisposed(position, true)` so that the per-task position
 * witness advances `messages` only across the contiguous-confirmed
 * prefix. The Redis progress tick can therefore be trusted for
 * crash-resume even with out-of-order completions.
 *
 * HTTP / mongo errors retry forever with exponential backoff
 * (1s → 30s). The writer treats `E11000` as success on its side, so a
 * 200 response is the only success signal we need. Persistent errors
 * (disk full, auth, oversized partial, writer down) intentionally hang
 * on this batch — the operator sees the log noise and intervenes; no
 * data is dropped.
 *
 * Shutdown is detected via `batch[0].task.stopSignal.triggered`. When
 * triggered mid-retry, the batch is abandoned — its items are not
 * acked, and the next run will re-stream them (deterministic `_id`
 * makes that idempotent via `E11000`).
 */

import { logger } from '@devvir/service-kit';
import { makeMongoId } from '@tradebot/utils';
import type { BitmexTable } from '@tradebot/types';
import { recordWrite } from '../metrics';
import { release } from './inflight';
import type { Item } from '../types';
import type { TableBatches } from './dispatch';

const RETRY_INITIAL_MS      = 1_000;
const RETRY_MAX_MS          = 30_000;
const MAX_BYTES_PER_REQUEST = 5_000_000;

// ── Public API ────────────────────────────────────────────────────────────────

export const startFlush = (
  librarianUrl:       string,
  batches:         TableBatches,
  flushIntervalMs: number,
  wireBytesCap:    number,
): NodeJS.Timeout => {
  /** Total content bytes currently inside in-flight HTTP requests (sum across all tables). */
  let wireBytes = 0;

  const tick = (): void => {
    for (const [table, items] of batches) {
      while (items.length > 0) {
        const count = sliceCount(items);
        const bytes = sumBytes(items, count);

        if (wireBytes + bytes > wireBytesCap) break;

        const batch = items.splice(0, count);

        release(batch.length);   // hand off writer-queue inflight
        wireBytes += bytes;      // claim wire-side inflight

        void postBatch(librarianUrl, table, batch)
          .finally(() => { wireBytes -= bytes; });
      }
    }
  };

  const timer = setInterval(tick, flushIntervalMs);

  timer.unref();

  return timer;
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Decide how many items to ship in the next batch, bounded by
 * `MAX_ROWS_PER_REQUEST` worth of `item.size` (bytes). Always takes at
 * least one item — if the first item alone already exceeds the cap
 * (e.g. a huge partial), it ships alone so progress can still be made.
 */
const sliceCount = (items: Item[]): number => {
  let bytes = items[0]!.size;
  let i     = 1;

  while (i < items.length && bytes + items[i]!.size <= MAX_BYTES_PER_REQUEST) {
    bytes += items[i]!.size;
    i++;
  }

  return i;
};

const sumBytes = (items: Item[], count: number): number => {
  let total = 0;

  for (let i = 0; i < count; i++)
    total += items[i]!.size;

  return total;
};

const postBatch = async (
  librarianUrl: string,
  table:     BitmexTable,
  batch:     Item[],
): Promise<void> => {
  const body = buildBody(batch);

  let delayMs = RETRY_INITIAL_MS;

  while (true) {
    try {
      const res = await fetch(`${librarianUrl}/${table}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (! res.ok) {
        const text = await res.text();

        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      /** Response body is `{ inserted, duplicates? }`; both shapes are success. */
      await res.json();

      onSuccess(batch);

      return;
    } catch (err) {
      logger.warn({ err, table, count: batch.length, delayMs }, 'Write to writer failed — retrying');

      if (batch[0]!.task.stopSignal.triggered) {
        logger.warn({ table, count: batch.length }, 'Shutdown signalled — abandoning batch');

        return;
      }

      await new Promise(r => setTimeout(r, delayMs));

      delayMs = Math.min(delayMs * 2, RETRY_MAX_MS);
    }
  }
};

/**
 * Build the HTTP body as a single JSON-array string — wire format is
 * `[<doc>,<doc>,...]`. Each doc is the item's already-wire-ready
 * `content` (REST = vault's raw line; WS = the template-spliced envelope
 * from assemble) with `_id` injected after the opening `{` via string
 * surgery. No JSON.parse, no JSON.stringify of objects — V8's array
 * `.join` is the only allocation beyond the per-item slice.
 */
const buildBody = (batch: Item[]): string => {
  const parts = new Array<string>(batch.length);

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]!;
    const id   = makeMongoId(item.task.date, item.position);

    parts[i] = `{"_id":${id},${item.content.slice(1)}`;
  }

  return `[${parts.join(',')}]`;
};

const onSuccess = (batch: Item[]): void => {
  recordWrite(batch.length);

  for (const item of batch)
    item.task.noteDisposed(item.position, true);
};

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_RETRY_INITIAL_MS     = RETRY_INITIAL_MS;
export const _test_RETRY_MAX_MS         = RETRY_MAX_MS;
export const _test_MAX_BYTES_PER_REQUEST = MAX_BYTES_PER_REQUEST;
export const _test_buildBody            = buildBody;
export const _test_sliceCount           = sliceCount;
