import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { error, info, section, spacer, success, warn } from '../log';
import { resolveCsvGzFiles } from '../discover';
import { allowsSimplifiedParsing, getVaultColumns, KNOWN_TABLES } from '../tables';
import { isDryRun } from '../options';
import type { RecoverOutcome, RowSpec, SanitizeStats } from './types';

const execFileAsync = promisify(execFile);

/** A line that opens with a complete ISO `_date_` field, e.g. `2026-04-11T00:00:00.020Z,`. */
const TIMESTAMP_LINE_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z,';

/** Printable-ASCII guard: any byte outside `0x20–0x7e` marks recovery garbage. */
const NON_ASCII = /[^\x20-\x7e]/;

/** Exact ISO-8601 millisecond timestamp, e.g. `2026-04-11T00:00:00.020Z`. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── gzip / gzrecover wrappers ─────────────────────────────────────────────────

async function isCorrupt(filePath: string): Promise<boolean> {
  try {
    await execFileAsync('gzip', ['-t', filePath]);

    return false;
  } catch {
    return true;
  }
}

/**
 * Recover one corrupt `.csv.gz`.
 *
 * gzrecover salvages the raw *content* — plain CSV text, not a gzip — keeping a
 * `.csv` extension. Crash-unclosed gzip members leave binary garbage at every
 * recovered member boundary (not just the tail), so for tables we can parse
 * field-by-field the recovered text is then run through a message-level sanitize
 * that drops every message touched by garbage and keeps all healthy ones.
 * Free-text / unknown tables (which can't be split on commas) fall back to
 * trimming only the scrambled tail.
 */
async function recoverFile(filePath: string): Promise<RecoverOutcome> {
  const ext     = '.csv.gz';
  const base    = filePath.endsWith(ext) ? filePath.slice(0, -ext.length) : filePath;
  const outPath = `${base}.recovered.csv`;

  await execFileAsync('gzrecover', ['-o', outPath, filePath]);

  const table   = tableNameFromPath(filePath);
  const columns = getVaultColumns(table);

  if (columns && allowsSimplifiedParsing(table)) {
    const tmp   = `${base}.recovered.tmp.csv`;
    const stats = await sanitize(outPath, tmp, rowSpec(columns));

    fs.renameSync(tmp, outPath);

    return { outPath, mode: 'sanitized', stats };
  }

  // Free-text / unknown table: can't validate fields, trim the scrambled tail only.
  const result = await pruneScrambledTail(outPath);

  return { outPath, mode: result };
}

// ── Message-level sanitize ────────────────────────────────────────────────────

function rowSpec(columns: string[]): RowSpec {
  return {
    cols:    columns.length,
    dateIdx: columns.indexOf('_date_'),
    tsIdx:   columns.indexOf('timestamp'),
  };
}

/**
 * A row is healthy when it is printable ASCII, has the table's exact column
 * count, carries an ISO `_date_` on a message's first row (empty on
 * continuations), and an ISO `timestamp` (when the table has that column).
 */
function validRow(row: string, isFirst: boolean, spec: RowSpec): boolean {
  if (NON_ASCII.test(row)) return false;

  const fields = row.split(',');

  if (fields.length !== spec.cols) return false;

  const date = fields[spec.dateIdx];

  if (isFirst) {
    if (! ISO.test(date!)) return false;
  } else {
    if (date !== '') return false;
  }

  return spec.tsIdx < 0 || ISO.test(fields[spec.tsIdx]!);
}

function validMessage(rows: string[], spec: RowSpec): boolean {
  for (let i = 0; i < rows.length; i++) {
    if (! validRow(rows[i]!, i === 0, spec)) return false;
  }

  return true;
}

/**
 * Stream `inPath`, group rows into messages (first row carries `_date_`;
 * continuation rows start with `,`), and write each message to `outPath` only
 * when every one of its rows is healthy — so a message touched by recovery
 * garbage is dropped whole, wherever it sits in the file. The header row passes
 * through verbatim. Writes honour backpressure so the output never buffers
 * unboundedly (a day's orderBookL2 is multi-GB).
 */
async function sanitize(inPath: string, outPath: string, spec: RowSpec): Promise<SanitizeStats> {
  const sink = createWriteStream(outPath);
  const rl   = createInterface({ input: createReadStream(inPath), crlfDelay: Infinity });

  const stats: SanitizeStats = { msgKept: 0, msgDropped: 0, rowsKept: 0, rowsDropped: 0 };

  let sawHeader = false;
  let current:  string[] | null = null;

  const writeBP = async (chunk: string): Promise<void> => {
    if (! sink.write(chunk)) await once(sink, 'drain');
  };

  const flush = async (): Promise<void> => {
    if (! current) return;

    if (validMessage(current, spec)) {
      stats.msgKept  += 1;
      stats.rowsKept += current.length;
      await writeBP(current.join('\n') + '\n');
    } else {
      stats.msgDropped  += 1;
      stats.rowsDropped += current.length;
    }

    current = null;
  };

  for await (const line of rl) {
    if (! sawHeader) {
      sawHeader = true;

      if (line.startsWith('_date_')) {
        await writeBP(line + '\n');
        continue;
      }
    }

    if (line.startsWith(',')) {
      if (current) {
        current.push(line);
      } else {
        // orphan continuation — no message in flight; pure garbage
        stats.msgDropped  += 1;
        stats.rowsDropped += 1;
      }

      continue;
    }

    await flush();
    current = [line];
  }

  await flush();

  sink.end();
  await finished(sink);

  return stats;
}

// ── Scrambled-tail fallback (free-text / unknown tables) ──────────────────────

/**
 * Trims the scrambled tail gzrecover leaves behind: truncates the recovered
 * CSV at the last line starting with a valid timestamp, dropping that line and
 * everything after it. Returns `'no-timestamp'` when nothing matched — the
 * file is left untouched.
 */
async function pruneScrambledTail(csvPath: string): Promise<'pruned' | 'no-timestamp'> {
  const offset = await lastTimestampOffset(csvPath);

  if (offset === null) return 'no-timestamp';

  fs.truncateSync(csvPath, offset);

  return 'pruned';
}

/**
 * Scans `csvPath` for the byte offset of the last line that begins with a
 * valid ISO timestamp. Streams grep's output line by line so a multi-GB file
 * with millions of matches never buffers in memory. Resolves `null` when no
 * such line exists.
 */
function lastTimestampOffset(csvPath: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // -a: treat the scrambled binary tail as text; -b: byte offset; -o: match only.
    const grep = spawn('grep', ['-aboE', TIMESTAMP_LINE_RE, csvPath]);

    let leftover = '';
    let lastLine = '';
    let stderr   = '';

    grep.stdout.on('data', (chunk: Buffer) => {
      const lines = (leftover + chunk.toString()).split('\n');

      leftover = lines.pop() ?? '';

      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.length > 0) {
          lastLine = lines[i]!;
          break;
        }
      }
    });

    grep.stderr.on('data', d => stderr += d.toString());
    grep.on('error', reject);

    grep.on('close', code => {
      if (code === 2) {
        reject(new Error(stderr.trim() || 'grep failed'));

        return;
      }

      if (! lastLine) {
        resolve(null);                 // grep exit 1 — no timestamped line found

        return;
      }

      // grep -b output is `<byteOffset>:<match>`; the offset is leading digits.
      resolve(parseInt(lastLine.slice(0, lastLine.indexOf(':')), 10));
    });
  });
}

/** Resolves the table name from a vault file path by its `<table>/` segment. */
function tableNameFromPath(filePath: string): string {
  const parts = filePath.split(path.sep);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (KNOWN_TABLES.has(parts[i]!)) return parts[i]!;
  }

  return path.basename(path.dirname(filePath));
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * `data recover` orchestrator. Tests every `.csv.gz` resolved from `root`
 * with `gzip -t` and (unless dry-run) recovers corrupt files via `gzrecover`,
 * then sanitizes the recovered CSV — dropping every message touched by recovery
 * garbage and keeping all healthy ones (tail-trim fallback for free-text tables).
 */
export async function runRecover(root: string): Promise<void> {
  const files = resolveCsvGzFiles(root);

  if (files.length === 0) {
    warn(`No .csv.gz files found under: ${root}`);

    return;
  }

  if (isDryRun()) {
    section('Dry-run — reporting corrupt files only');
    spacer();
  }

  let ok        = 0;
  let corrupt   = 0;
  let recovered = 0;
  let failed    = 0;

  for (const file of files) {
    info(`Checking ${file} …`);

    if (! await isCorrupt(file)) {
      success('  OK');
      ok++;
      continue;
    }

    warn('  Corrupt');
    corrupt++;

    if (isDryRun()) continue;

    try {
      const outcome = await recoverFile(file);
      recovered++;
      reportOutcome(outcome);
    } catch (err) {
      error(`  Recovery failed: ${(err as Error).message}`);
      failed++;
    }
  }

  spacer();

  if (isDryRun()) {
    info(`Done. OK: ${ok}. Corrupt: ${corrupt}.`);

    return;
  }

  if (failed > 0) {
    error(`Done. OK: ${ok}. Corrupt: ${corrupt}. Recovered: ${recovered}. Failed to recover: ${failed}.`);
  } else {
    success(`Done. OK: ${ok}. Corrupt: ${corrupt}. Recovered: ${recovered}.`);
  }
}

function reportOutcome(outcome: RecoverOutcome): void {
  const name = path.basename(outcome.outPath);

  if (outcome.mode === 'sanitized' && outcome.stats) {
    const { msgKept, msgDropped, rowsKept, rowsDropped } = outcome.stats;

    info(`  Recovered & sanitized → ${name}`);
    info(`    messages: kept ${msgKept.toLocaleString()}, dropped ${msgDropped.toLocaleString()}` +
         `  |  rows: kept ${rowsKept.toLocaleString()}, dropped ${rowsDropped.toLocaleString()}`);
  } else if (outcome.mode === 'pruned') {
    info(`  Recovered & tail-trimmed → ${name}`);
  } else {
    warn(`  Recovered → ${name} — no valid timestamp found, not trimmed`);
  }
}

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_isCorrupt           = isCorrupt;
export const _test_recoverFile         = recoverFile;
export const _test_sanitize            = sanitize;
export const _test_validRow            = validRow;
export const _test_validMessage        = validMessage;
export const _test_rowSpec             = rowSpec;
export const _test_pruneScrambledTail  = pruneScrambledTail;
export const _test_lastTimestampOffset = lastTimestampOffset;
export const _test_tableNameFromPath   = tableNameFromPath;
