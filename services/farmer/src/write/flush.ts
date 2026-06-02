/**
 * Per-table batch flusher.
 *
 * Runs on a periodic timer. Each tick round-robins a fixed budget of
 * concurrent in-flight requests across all tables with pending items — one
 * batch per table per pass, looping until the budget is exhausted — starting
 * from a rotating offset. This keeps a single fat table (e.g. orderBookL2)
 * from hogging every slot and starving the tables inserted into `batches`
 * after it. Each batch is one POST capped at `MAX_BYTES_PER_REQUEST`, so a
 * slot is a slot regardless of size; `maxInFlightRequests` bounds how many
 * run at once. Splicing a batch out `release`s its bytes from the staging
 * gate (unblocking the readers) and claims one in-flight request slot, freed
 * again when the POST settles.
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
import { release } from './staging';
import type { Item } from '../types';
import type { TableBatches } from './dispatch';

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS     = 30_000;

/**
 * Hard ceiling on a single POST body. The binding constraint is the
 * librarian's 32 MiB express body limit (plus mongo's 48 MiB message / 16 MiB
 * per-doc limits). Internal, not an env knob — a safety bound, not a tuning
 * surface — and the staging + read-buffer byte ceilings derive from it.
 */
export const MAX_BYTES_PER_REQUEST = 8 * 1024 * 1024;

// ── Public API ────────────────────────────────────────────────────────────────

export const startFlush = (
  librarianUrl:        string,
  batches:             TableBatches,
  flushIntervalMs:     number,
  maxInFlightRequests: number,
): NodeJS.Timeout => {
  /** POSTs sent and not yet settled (sum across all tables). */
  let inFlightRequests = 0;
  /** Rotating start offset so no table is permanently served first when slots saturate. */
  let cursor           = 0;

  /**
   * Round-robin the in-flight request budget across tables: one batch per
   * table per pass, looping until every slot is busy or a full pass ships
   * nothing. The pass starts at a rotating offset, so a fat early table can no
   * longer hog the slots and starve tables inserted after it.
   */
  const tick = (): void => {
    const tables = [...batches.keys()];

    if (tables.length === 0) return;

    const start = cursor++ % tables.length;

    let progressed = true;

    while (progressed) {
      progressed = false;

      for (let i = 0; i < tables.length; i++) {
        if (inFlightRequests >= maxInFlightRequests) return;

        const table = tables[(start + i) % tables.length]!;
        const items = batches.get(table);

        if (! items || items.length === 0) continue;

        const count = sliceCount(items);
        const bytes = sumBytes(items, count);
        const batch = items.splice(0, count);

        release(bytes);       // out of the staging gate → unblocks the readers
        inFlightRequests++;   // claim an in-flight request slot

        void postBatch(librarianUrl, table, batch)
          .finally(() => { inFlightRequests--; });

        progressed = true;
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
 * `MAX_BYTES_PER_REQUEST` worth of `item.size` (bytes). Always takes at
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

export const _test_RETRY_INITIAL_MS = RETRY_INITIAL_MS;
export const _test_RETRY_MAX_MS     = RETRY_MAX_MS;
export const _test_buildBody        = buildBody;
export const _test_sliceCount       = sliceCount;
