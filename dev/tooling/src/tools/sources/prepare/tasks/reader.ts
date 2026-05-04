import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createCsvParser } from '@tradebot/utils';
import { debug } from '../../../../shared/ui/logger';
import { getVaultColumns, hasFixedPartials } from '../../tables';
import type { Action, PreparedMessage, ReadIssue } from '../types';
import { ACTIONS } from '../types';

const BATCH_SIZE = 20_000;

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * READ — stream a single source `.csv.gz` file as validated `PreparedMessage`
 * batches.
 *
 * Pipeline position: READ is the boundary between untyped CSV bytes and the
 * typed pipeline. Everything downstream trusts the `PreparedMessage` contract
 * without defensive casts.
 *
 * Per-message work, in order:
 *  1. Parse with `createCsvParser(false)` to receive raw `string[]` arrays
 *     (csv-parse handles RFC-4180 quoting / multi-line / embedded commas).
 *  2. Drop the first record if it is the header row.
 *  3. Validate field count: every row must have exactly `columns.length`
 *     fields. A short or long row corrupts the message — discard it.
 *  4. Group rows into messages (non-empty first field starts a new message;
 *     empty-first-field rows are continuations).
 *  5. Validate `_date_` (ISO regex), `_action_` (one of the four actions),
 *     and `timestamp` (ISO regex) on every row when non-empty. A whole
 *     message is dropped on any failure.
 *  6. For fixed-partial tables, drop any `partial` action — the synthetic
 *     partial written by HEADER is the only one in the output.
 *  7. Compute `ts`, `tsMs`, `hash`. Partials get `hash: null` (never hashed).
 *  8. Emit batches.
 *
 * Backpressure is handled by the caller (the source actor in `sorter.ts`)
 * which controls when to advance this generator.
 */
export async function* read(
  tableName: string,
  filePath:  string,
  onIssue:   (issue: ReadIssue) => void,
): AsyncGenerator<PreparedMessage[]> {
  const columns       = getVaultColumns(tableName);
  const fixedPartials = hasFixedPartials(tableName);

  if (! columns) {
    throw new Error(`reader: no vault columns for table "${tableName}"`);
  }

  const name    = path.basename(filePath);
  const raw     = fs.createReadStream(filePath);
  const byteSrc = filePath.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;

  plog(`[READ] start: ${name}`);
  // `relaxColumnCount: true` — prepare detects field-count mismatches itself
  // and discards the corrupted message (with logging) rather than aborting
  // the whole stream.
  const parser  = createCsvParser(false, true);

  byteSrc.pipe(parser);

  const dateIdx      = columns.indexOf('_date_');
  const actionIdx    = columns.indexOf('_action_');
  const timestampIdx = columns.indexOf('timestamp');   // -1 when absent

  if (dateIdx === -1 || actionIdx === -1) {
    throw new Error(`reader: columns must include _date_ and _action_ — got [${columns.join(',')}]`);
  }

  const expectedLen = columns.length;
  const batch:        PreparedMessage[]     = [];
  let   currentRows:  string[][]            = [];
  let   skipCurrent   = false;
  let   sawHeader     = false;
  let   batchN        = 0;
  let   totalYielded  = 0;

  // Diagnostic timing accumulators (reset each batch).
  let   batchRowCount  = 0;         // raw CSV rows seen this batch
  let   finalizeMs     = 0;         // cumulative ms spent inside finalize()
  let   batchStartMs   = Date.now(); // wall-clock start of current batch

  for await (const record of parser as AsyncIterable<string[]>) {
    batchRowCount++;

    // 1. Skip the header row (first record only).
    if (! sawHeader) {
      sawHeader = true;

      if (record[dateIdx] === '_date_') {
        continue;
      }
    }

    // 2. Field-count validation.
    if (record.length !== expectedLen) {
      onIssue({
        reason: `field count ${record.length} != expected ${expectedLen}`,
        date:   record[dateIdx] ?? '',
      });

      // If this row would have started a new message, drop the message it
      // begins. If it's a continuation, drop whatever message it belongs to.
      if (record[dateIdx]) {
        currentRows = [];
        skipCurrent = true;
      } else {
        skipCurrent = true;
      }

      continue;
    }

    const dateField = (record[dateIdx]  ?? '').trim();
    const isStart   = dateField !== '';

    // 3. Row grouping.
    if (isStart) {
      // Flush the previous message before starting a new one.
      if (currentRows.length > 0 && ! skipCurrent) {
        const t0  = Date.now();
        const msg = finalize(currentRows, columns, dateIdx, actionIdx, timestampIdx, fixedPartials, onIssue);

        finalizeMs += Date.now() - t0;

        if (msg) {
          batch.push(msg);
        }
      }

      currentRows = [record];
      skipCurrent = false;
    } else if (currentRows.length > 0) {
      currentRows.push(record);
    }
    // Orphan continuation row (no message in flight): silently drop, same
    // behaviour as the existing reader.

    // 4. Yield batches.
    if (batch.length >= BATCH_SIZE) {
      batchN++;
      totalYielded += batch.length;

      const elapsed   = Date.now() - batchStartMs;
      const streamMs  = elapsed - finalizeMs;

      plog(`[READ] ${name} batch ${batchN}: ${batch.length} msgs | ${batchRowCount} rows | total: ${totalYielded} | elapsed: ${elapsed}ms (stream: ${streamMs}ms, finalize: ${finalizeMs}ms)`);

      yield batch.splice(0);

      batchRowCount = 0;
      finalizeMs    = 0;
      batchStartMs  = Date.now();
    }
  }

  // Flush the last in-flight message.
  if (currentRows.length > 0 && ! skipCurrent) {
    const msg = finalize(currentRows, columns, dateIdx, actionIdx, timestampIdx, fixedPartials, onIssue);

    if (msg) {
      batch.push(msg);
    }
  }

  if (batch.length > 0) {
    batchN++;
    totalYielded += batch.length;

    const elapsed  = Date.now() - batchStartMs;
    const streamMs = elapsed - finalizeMs;

    plog(`[READ] ${name} batch ${batchN} (final): ${batch.length} msgs | ${batchRowCount} rows | total: ${totalYielded} | elapsed: ${elapsed}ms (stream: ${streamMs}ms, finalize: ${finalizeMs}ms)`);

    yield batch;
  }

  plog(`[READ] ${name} done — ${batchN} batches, ${totalYielded} msgs total`);
}

// ── Internal: validate and finalize a message ────────────────────────────────

function finalize(
  rows:          string[][],
  columns:       string[],
  dateIdx:       number,
  actionIdx:     number,
  timestampIdx:  number,
  fixedPartials: boolean,
  onIssue:       (issue: ReadIssue) => void,
): PreparedMessage | null {
  const startRow = rows[0]!;
  const date     = startRow[dateIdx]!.trim();
  const action   = startRow[actionIdx]!.trim();
  const tsRaw    = timestampIdx === -1 ? '' : (startRow[timestampIdx] ?? '').trim();

  if (! ISO_DATE_RE.test(date)) {
    onIssue({ reason: `invalid _date_: "${date}"`, date });

    return null;
  }

  if (! ACTIONS.has(action as Action)) {
    onIssue({ reason: `invalid _action_: "${action}"`, date });

    return null;
  }

  // Validate timestamp on every row (when the column exists and the value is
  // non-empty). Continuation rows can carry their own timestamps for tables
  // where rows-within-a-message represent distinct events.
  if (timestampIdx !== -1) {
    for (const row of rows) {
      const t = (row[timestampIdx] ?? '').trim();

      if (t !== '' && ! ISO_DATE_RE.test(t)) {
        onIssue({ reason: `invalid timestamp: "${t}"`, date });

        return null;
      }
    }
  }

  // Drop fixed-partial-table partials: the synthetic partial in HEADER is
  // the only one we keep.
  if (fixedPartials && action === 'partial') {
    return null;
  }

  // Materialize Record<string, string> rows. Empty fields are kept as ''
  // (round-trip safe; csv-parse already canonicalises).
  const records = rows.map(r => recordFromArray(r, columns));

  const ts   = (tsRaw !== '' ? tsRaw : date).slice(0, 23);
  const tsMs = isoToMs(ts);

  return {
    rows:      records,
    date,
    action:    action as Action,
    timestamp: tsRaw,
    ts,
    tsMs,
  };
}

function recordFromArray(row: string[], columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};

  for (let i = 0; i < columns.length; i++) {
    out[columns[i]!] = row[i] ?? '';
  }

  return out;
}

// ── Internal: ISO date validation and ms conversion ──────────────────────────

/**
 * BitMEX WS messages always emit UTC with `Z`. Decimals are optional; legacy
 * files have 8 or 9 (we slice to 3 in `ts`, but accept any length here).
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Extract epoch ms from a sliced 23-char ISO string (`YYYY-MM-DDTHH:mm:ss.sss`).
 * Pure positional arithmetic via `Date.UTC` — no locale, no timezone parsing.
 */
function isoToMs(ts: string): number {
  const year   = +ts.slice(0, 4);
  const month  = +ts.slice(5, 7) - 1;
  const day    = +ts.slice(8, 10);
  const hour   = +ts.slice(11, 13);
  const minute = +ts.slice(14, 16);
  const second = +ts.slice(17, 19);
  const millis = ts.length > 20 ? +ts.slice(20, 23) : 0;

  return Date.UTC(year, month, day, hour, minute, second, millis);
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_isoToMs     = isoToMs;
export const _test_ISO_DATE_RE = ISO_DATE_RE;
