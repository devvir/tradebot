import path from 'node:path';
import readline from 'node:readline';
import { createReader } from '@devvir/zipper';
import { arrayToCsv, createCsvParser } from '@tradebot/utils';
import { debug } from '../../../../shared/ui/logger';
import { allowsSimplifiedParsing, getVaultColumns, hasFixedPartials } from '../../tables';
import type { Action, PreparedMessage, ReadIssue, RecordResult } from '../types';
import { ACTIONS, isPartialAction } from '../types';
import { createTsResolver, type TsResolver } from './ts-resolver';

const BATCH_SIZE = 20_000;

const plog = (msg: string): void => { debug(`[${new Date().toISOString()}] ${msg}`); };

/**
 * Stream a `.csv.gz` source file as validated `PreparedMessage` batches.
 * Tables flagged for simplified parsing skip csv-parse and feed raw readline
 * lines through. Each row group becomes a single message; whole messages are
 * dropped on validation failure.
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
  const byteSrc = createReader(filePath).stream();

  plog(`[READ] start: ${name}`);

  const dateIdx      = columns.indexOf('_date_');
  const actionIdx    = columns.indexOf('_action_');
  const timestampIdx = columns.indexOf('timestamp');   // -1 when absent

  if (dateIdx === -1 || actionIdx === -1) {
    throw new Error(`reader: columns must include _date_ and _action_ — got [${columns.join(',')}]`);
  }

  const records = allowsSimplifiedParsing(tableName)
    ? splitRecords(byteSrc)
    : csvRecords(byteSrc, columns.length, dateIdx, onIssue);

  const tsResolver = createTsResolver();

  const batch:       PreparedMessage[] = [];
  let   currentRows: string[]          = [];
  let   skipCurrent  = false;
  let   sawHeader    = false;
  let   batchN       = 0;
  let   totalYielded = 0;

  // Diagnostic timing accumulators (reset each batch).
  let   batchRowCount = 0;
  let   finalizeMs    = 0;
  let   batchStartMs  = Date.now();

  for await (const result of records) {
    batchRowCount++;

    if (! sawHeader) {
      sawHeader = true;

      if (! result.ok || result.line.startsWith('_date_')) {
        continue;
      }
    }

    if (! result.ok) {
      onIssue(result.issue);

      if (result.isStart) {
        currentRows = [];
      }

      skipCurrent = true;
      continue;
    }

    const line    = result.line;
    const isStart = ! line.startsWith(',');

    if (isStart) {
      if (currentRows.length > 0 && ! skipCurrent) {
        const t0  = Date.now();
        const msg = finalize(currentRows, dateIdx, actionIdx, timestampIdx, fixedPartials, tsResolver, onIssue);

        finalizeMs += Date.now() - t0;

        if (msg) {
          batch.push(msg);
        }
      }

      currentRows = [line];
      skipCurrent = false;
    } else if (currentRows.length > 0) {
      currentRows.push(line);
    }

    /** Orphan continuation rows (no message in flight) are silently dropped. */

    if (batch.length >= BATCH_SIZE) {
      batchN++;
      totalYielded += batch.length;

      const elapsed  = Date.now() - batchStartMs;
      const streamMs = elapsed - finalizeMs;

      plog(`[READ] ${name} batch ${batchN}: ${batch.length} msgs | ${batchRowCount} rows | total: ${totalYielded} | elapsed: ${elapsed}ms (stream: ${streamMs}ms, finalize: ${finalizeMs}ms)`);

      yield batch.splice(0);

      batchRowCount = 0;
      finalizeMs    = 0;
      batchStartMs  = Date.now();
    }
  }

  // Flush the last in-flight message.
  if (currentRows.length > 0 && ! skipCurrent) {
    const msg = finalize(currentRows, dateIdx, actionIdx, timestampIdx, fixedPartials, tsResolver, onIssue);

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

// ── Internal: record sources ─────────────────────────────────────────────────

/**
 * csv-parse path: validates field count and normalises each row via
 * `arrayToCsv` to a canonical CSV line.
 */
async function* csvRecords(
  src:         NodeJS.ReadableStream,
  expectedLen: number,
  dateIdx:     number,
  _onIssue:    (issue: ReadIssue) => void,
): AsyncGenerator<RecordResult> {
  const parser = createCsvParser(false, true);

  src.pipe(parser as unknown as NodeJS.WritableStream);

  for await (const record of parser as unknown as AsyncIterable<string[]>) {
    if (record.length !== expectedLen) {
      const date    = record[dateIdx] ?? '';
      const isStart = date.trim() !== '';

      yield { ok: false, isStart, issue: { reason: `field count ${record.length} != expected ${expectedLen}`, date } };
    } else {
      yield { ok: true, line: arrayToCsv(record) };
    }
  }
}

/** Simplified readline path: yields raw lines as-is, no field-count check. */
async function* splitRecords(src: NodeJS.ReadableStream): AsyncGenerator<RecordResult> {
  const rl = readline.createInterface({ input: src, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length > 0) {
      yield { ok: true, line };
    }
  }
}

// ── Internal: validate and finalize a message ────────────────────────────────

function finalize(
  rows:          string[],
  dateIdx:       number,
  actionIdx:     number,
  timestampIdx:  number,
  fixedPartials: boolean,
  tsResolver:    TsResolver,
  onIssue:       (issue: ReadIssue) => void,
): PreparedMessage | null {
  /** Limited split: scan only up to the last index we need. */
  const splitTo = Math.max(actionIdx, timestampIdx === -1 ? 0 : timestampIdx) + 1;
  const fields  = rows[0]!.split(',', splitTo);

  const date   = (fields[dateIdx]   ?? '').trim();
  const action = (fields[actionIdx] ?? '').trim();
  const tsRaw  = timestampIdx === -1 ? null : (fields[timestampIdx] ?? '').trim();

  if (! ISO_DATE_RE.test(date)) {
    onIssue({ reason: `invalid _date_: "${date}"`, date });

    return null;
  }

  if (! ACTIONS.has(action) && ! isPartialAction(action)) {
    onIssue({ reason: `invalid _action_: "${action}"`, date });

    return null;
  }

  if (timestampIdx !== -1) {
    for (const row of rows) {
      const t = (row.split(',', timestampIdx + 1)[timestampIdx] ?? '').trim();

      if (t !== '' && ! ISO_DATE_RE.test(t)) {
        onIssue({ reason: `invalid timestamp: "${t}"`, date });

        return null;
      }
    }
  }

  if (fixedPartials && isPartialAction(action)) {
    return null;
  }

  const { ts, tsMs } = tsResolver.resolve(tsRaw, date);

  return {
    rows,
    date,
    action:    action as Action,
    timestamp: tsRaw,
    ts,
    tsMs,
  };
}

// ── Internal: ISO date validation ────────────────────────────────────────────

/**
 * UTC, with optional decimals. Legacy files use 8-or-9-digit subseconds;
 * regex accepts any length, but `ts` is sliced to 3 digits downstream.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_ISO_DATE_RE = ISO_DATE_RE;
