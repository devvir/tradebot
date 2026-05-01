import { rowToCsv } from '@tradebot/utils';
import { error } from '../../../shared/ui/logger';
import { WINDOW_MINUTES } from '../checks/duplicates';
import { streamMessages } from '../reader';
import type { Writer } from '../writer';
import type { Message } from '../types';
import type { MessageCheck, CheckContext, DiagnosticIssue, IssueSummary } from '../checks/types';
import { createIssueSummary, addToSummary } from '../checks/types';
import type { DiagnosticLog } from './log';

export interface PipelineResult {
  messageCount:    number;
  writtenCount:    number;
  summary:         IssueSummary;
  forcedEvictions: number;
}

/**
 * Buckets hold raw CSV lines, not parsed `Message` objects. Reconstructing the
 * CSV via `rowToCsv` at stream time and dropping the parsed record keeps the
 * resident set down by ~10× for wide/sparse tables like `instrument`, where a
 * ~120-column `Record<string, string>` is dominated by hidden-class slots for
 * empty columns. Sort key is extracted once, alongside the lines.
 */
interface BucketEntry {
  rawLines: string[];
  sortKey:  string;
}

/**
 * Total entries across all pending buckets above which we force-evict the
 * oldest bucket, even if the bucket-count window is not yet full. Safety net
 * against pathological bursts — with raw-line bucketing (~10× less memory
 * than parsed messages) this threshold should never trip on normal BitMEX
 * backfill bursts. Left in place so we fail loudly and informatively rather
 * than OOM silently if a future burst exceeds expectations.
 */
const MAX_PENDING_ENTRIES = 3_000_000;

/**
 * Stream messages through a canonical-minute bucket-flush pipeline.
 *
 * Each message is placed in a bucket keyed by its canonical minute. At most
 * `WINDOW_MINUTES` buckets are held in memory. When the window overflows, the
 * oldest bucket is sorted and flushed to the writer. Under memory pressure
 * (`MAX_PENDING_ENTRIES`), buckets are evicted earlier than `WINDOW_MINUTES`
 * would require, which narrows the effective dedup window — a second pass
 * over the output will re-sort any out-of-order messages and catch duplicates
 * that slipped through. `forcedEvictions` in the result signals when this
 * happened.
 */
export async function runPipeline(
  filePath:        string,
  ctx:             CheckContext,
  checks:          MessageCheck[],
  sourceHasHeader: boolean,
  writer:          Writer,
  log:             DiagnosticLog,
): Promise<PipelineResult> {
  const summary: IssueSummary = createIssueSummary();
  const pending: Map<string, BucketEntry[]> = new Map();
  const outputCols = ctx.header?.columns ?? null;

  let flushFloor: string | null = null;
  let messageCount    = 0;
  let writtenCount    = 0;
  let pendingEntries  = 0;
  let forcedEvictions = 0;

  const parseColumns: true | string[] = sourceHasHeader
    ? true
    : (ctx.header?.columns ?? []);

  try {
    for await (const msg of streamMessages(filePath, parseColumns)) {
      messageCount++;

      const perMsg = runChecks(checks, msg, ctx);
      const mSort  = sortKey(msg, ctx.timestampCol);
      const mKey   = mSort.slice(0, 16);

      if (flushFloor !== null && mKey <= flushFloor) {
        if (
          ctx.tableName === 'instrument' &&
          msg.action === 'update' &&
          Date.parse(msg.date) - Date.parse(msg.timestamp) > 30 * 60 * 1000
        ) {
          const issue = {
            type: 'wrong-order' as const,
            date: msg.date,
            message: `instrument update dropped: timestamp ${msg.timestamp} is more than 30 min before received time ${msg.date}`,
          };

          addToSummary(summary, issue);
          log.issue(issue);
          continue;
        }

        const issue = {
          type: 'wrong-order' as const,
          date: msg.date,
          message: `canonical minute ${mKey} is older than already-flushed window (floor ${flushFloor}); written out of order, re-run to re-sort`,
        };

        addToSummary(summary, issue);
        log.issue(issue);

        /**
         * Pass-through: write the message immediately rather than dropping it.
         * It lands in the output right after the flushed window, so a second
         * pass will re-sort it into place (its bucket will still be in the
         * re-read window when the message is re-encountered). Dedup still
         * gates the write via `shouldWrite`.
         */
        if (perMsg.shouldWrite && outputCols) {
          await writer.writeRaw(msg.rows.map(row => rowToCsv(row, outputCols)));
          writtenCount++;
        }

        continue;
      }

      for (const issue of perMsg.issues) {
        addToSummary(summary, issue);
        log.issue(issue);
      }

      /**
       * Dropped messages (duplicates, header-in-wrong-row) never reach the
       * output, so skip bucketing them entirely — no raw-line reconstruction,
       * no memory footprint, no contribution to `pendingEntries`. The parsed
       * `Message` falls out of scope on the next iteration.
       */
      if (! perMsg.shouldWrite || ! outputCols) continue;

      const rawLines = msg.rows.map(row => rowToCsv(row, outputCols));

      let bucket = pending.get(mKey);

      if (! bucket) {
        bucket = [];
        pending.set(mKey, bucket);
      }

      bucket.push({ rawLines, sortKey: mSort });
      pendingEntries++;

      while (pending.size > WINDOW_MINUTES || pendingEntries > MAX_PENDING_ENTRIES) {
        const triggeredByCount = pending.size > WINDOW_MINUTES;
        const oldest            = oldestKey(pending);

        if (oldest === null) break;

        const evicted = pending.get(oldest)!;

        pending.delete(oldest);
        pendingEntries -= evicted.length;
        flushFloor      = oldest;

        if (! triggeredByCount) {
          forcedEvictions++;
        }

        writtenCount += await flushBucket(evicted, writer);
      }
    }
  } catch (err) {
    error(`Stream failed: ${(err as Error).message}`);
  }

  // Drain remaining buckets in order.
  for (const key of Array.from(pending.keys()).sort()) {
    writtenCount += await flushBucket(pending.get(key)!, writer);
  }

  // Let checks emit trailing issues.
  for (const check of checks) {
    if (check.flush) {
      for (const issue of check.flush(ctx)) {
        addToSummary(summary, issue);
        log.issue(issue);
      }
    }
  }

  return { messageCount, writtenCount, summary, forcedEvictions };
}

// ── Check dispatch ────────────────────────────────────────────────────────────

function runChecks(
  checks: MessageCheck[],
  msg:    Message,
  ctx:    CheckContext,
): { issues: DiagnosticIssue[]; shouldWrite: boolean } {
  const collected: DiagnosticIssue[] = [];

  for (const check of checks) {
    collected.push(...check.onMessage(msg, ctx));
  }

  const hasDuplicate        = collected.some(i => i.type === 'duplicate');
  const hasHeaderInWrongRow = collected.some(i => i.type === 'header-in-wrong-row');

  // Suppress wrong-order on messages already flagged as duplicates.
  const issues = hasDuplicate
    ? collected.filter(i => i.type !== 'wrong-order')
    : collected;

  return {
    issues,
    shouldWrite: ! hasDuplicate && ! hasHeaderInWrongRow,
  };
}

// ── Bucket helpers ────────────────────────────────────────────────────────────

async function flushBucket(bucket: BucketEntry[], writer: Writer): Promise<number> {
  bucket.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  for (const entry of bucket) {
    await writer.writeRaw(entry.rawLines);
  }

  return bucket.length;
}

export function bucketKey(msg: Message, timestampCol: string | null): string {
  const canonical = timestampCol && msg.timestamp ? msg.timestamp : msg.date;

  return canonical.slice(0, 16);
}

export function sortKey(msg: Message, timestampCol: string | null): string {
  return timestampCol && msg.timestamp ? msg.timestamp : msg.date;
}

export function oldestKey(buckets: Map<string, unknown>): string | null {
  let min: string | null = null;

  for (const k of buckets.keys()) {
    if (min === null || k < min) min = k;
  }

  return min;
}
