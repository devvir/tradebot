import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { info, warn } from '../../../shared/ui/logger';
import { fmtNum, fmtElapsed } from '../utils/format';
import { ProgressBlock } from '../utils/progress-block';
import { getEnv } from '../../../shared/utils/env';
import { mongoUri } from '../utils/connect';
import { dumpStatKey } from './dumplog';
import type { Pair, PlanRow } from '../types';
import type {
  RestoreTarget,
  RestoreOutcome,
  MongoRestoreOptions,
  MongoRestoreProgress,
  MongoRestoreResult,
  ExecuteRestoreOptions,
  DumpStat,
} from './types';

const DEFAULT_CONCURRENCY = 4;

// Fallback only. The accurate denominator is the uncompressed BSON size read
// from dump.log (see `dumpStats`); we reach this estimate only when an archive
// isn't in the log. mongorestore reports uncompressed bytes, while we know only
// the compressed archive size, so we scale by a rough gzip ratio. Measured
// ratios run ~8–13× across tables (instrument ≈ 8.7, orderBookL2 ≈ 13); 12 is a
// deliberately high-ish single estimate so the bar doesn't peg at 100% early.
const UNCOMPRESSED_RATIO_ESTIMATE = 12;

// mongorestore --verbose stderr formats:
//   progress (each ~3 s):  `<timestamp>\t<db>.<coll>  <value><unit>`   e.g.  `tradebot.quoteBin1h  10.4MB`
//   final summary:         `<N> document(s) restored successfully. <M> document(s) failed to restore.`
const PROGRESS_RE = /\s\S+\.\S+\s+(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)\s*$/;
const DONE_RE     = /(\d+)\s+document\(s\)\s+restored\s+successfully/i;

// Duplicate-key errors ONLY. Restores are idempotent and we don't pass
// --stopOnError, so re-restoring an archive into an existing collection skips
// every already-present _id and mongorestore logs one line per skip. On a
// billions-doc archive that's a billions-line torrent — collapsed to a count.
// Nothing else is collapsed: a doc that genuinely failed to write stays in the
// log so corruption/loss can't hide behind the noise.
const DUP_KEY_RE = /E11000|duplicate key/i;

// Hard ceiling on retained (non-duplicate-key) stderr lines, so a pathological
// flood of *unexpected* errors truncates loudly instead of OOMing the process.
// A healthy restore keeps a few dozen lines; reaching this means something is
// wrong and worth inspecting.
const MAX_LOG_LINES = 100_000;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Run `mongorestore --gzip --archive=<path>` for each target with a local
 * file. Parallel pool (default 4, overridable via `DB_RESTORE_CONCURRENCY`).
 * Reuses the dump's `ProgressBlock` so the on-screen progress UX matches.
 *
 * Duplicate `_id` errors are ignored: mongorestore continues by default and
 * we don't pass `--stopOnError`. The user told us to assume they know what
 * they're doing.
 */
export async function executeRestore(
  targets: RestoreTarget[],
  options: ExecuteRestoreOptions = {},
): Promise<RestoreOutcome[]> {
  const envConcurrency = parseInt(getEnv('DB_RESTORE_CONCURRENCY') ?? '', 10);
  const concurrency    = options.concurrency ?? (
    Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : DEFAULT_CONCURRENCY
  );

  const ready = targets.filter(t => t.local);
  const total = ready.length;

  if (total === 0) {
    warn('No local archives available to restore.');
    return [];
  }

  info(`Restoring ${total} archive${total === 1 ? '' : 's'} via mongorestore (concurrency: ${concurrency})`);

  const uri      = mongoUri();
  const outcomes: RestoreOutcome[] = new Array(total);
  const progress = new ProgressBlock(total);
  const { nsFrom, nsTo, dumpStats } = options;

  let next = 0;

  async function worker(): Promise<void> {
    while (next < total) {
      const idx    = next++;
      const target = ready[idx];

      outcomes[idx] = await restoreOne(uri, target, idx, total, progress, nsFrom, nsTo, dumpStats);
    }
  }

  try {
    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());

    await Promise.all(workers);
  } finally {
    progress.stop();
  }

  return outcomes;
}

// ── Internals ────────────────────────────────────────────────────────────────

async function restoreOne(
  uri:       string,
  target:    RestoreTarget,
  idx:       number,
  total:     number,
  progress:  ProgressBlock,
  nsFrom?:   string,
  nsTo?:     string,
  dumpStats?: Map<string, DumpStat>,
): Promise<RestoreOutcome> {
  const prefix = `[${idx + 1}/${total}] ${target.collection} [${target.key}]`;
  const start  = Date.now();

  // ProgressBlock measures `done / row.count`, and mongorestore's running
  // counter is uncompressed BSON bytes. The accurate total is the uncompressed
  // size dump.log recorded for this archive (`docs × avgObjSize`); only when
  // the archive isn't in the log do we fall back to compressedSize × ratio.
  // Both `done` and `count` are bytes — the block's fmtCount renders them as
  // "10.4M"/"30.0M" which in this context reads as MB.
  const pair: Pair    = { collection: target.collection, date: null };
  const stat          = dumpStats?.get(dumpStatKey(target.collection, target.key));
  const expectedBytes = stat ? stat.bytes : target.local!.size * UNCOMPRESSED_RATIO_ESTIMATE;
  const row:  PlanRow = { ...pair, count: expectedBytes, avgObjSize: 0, periodLabel: target.key };
  const key           = `restore|${target.collection}|${target.key}`;

  progress.pairStart(key, idx, row);

  try {
    const result = await runMongoRestore({
      uri,
      archivePath: target.local!.path,
      nsFrom,
      nsTo,
      onProgress:  p => progress.pairUpdate(key, p.done),
      logPath:     `${target.local!.path}.restore.log`,
    });

    progress.pairDone(
      key,
      `✓ ${prefix}  ${fmtNum(result.documents)} docs · ${fmtElapsed(result.elapsedMs / 1000)}`,
    );

    return {
      collection: target.collection,
      key:        target.key,
      documents:  result.documents,
      elapsedMs:  Date.now() - start,
    };
  } catch (err) {
    const message = (err as Error).message;

    progress.pairFail(key, `✗ ${prefix}  FAILED: ${message}`);

    return {
      collection: target.collection,
      key:        target.key,
      elapsedMs:  Date.now() - start,
      error:      message,
    };
  }
}

function runMongoRestore(opts: MongoRestoreOptions): Promise<MongoRestoreResult> {
  const args = [
    `--uri=${opts.uri}`,
    `--archive=${opts.archivePath}`,
    '--gzip',
    '--verbose',
  ];

  // Namespace remap (e.g. restore into a side database for comparison).
  if (opts.nsFrom && opts.nsTo) {
    args.push(`--nsFrom=${opts.nsFrom}`, `--nsTo=${opts.nsTo}`);
  }

  const start = Date.now();

  return new Promise<MongoRestoreResult>((resolve, reject) => {
    const proc = spawn('mongorestore', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let finishedDocs = 0;          // final doc count, from the summary line
    let stderrTail   = '';
    let buffer       = '';
    const logLines:    string[] = [];   // non-progress stderr: prelude, warnings, errors, summary
    let dupKeyErrors = 0;          // collapsed: expected, idempotent — never retained per-line
    let firstDupKey  = '';         // one example, for the summary
    let droppedLines = 0;          // non-dup lines shed past MAX_LOG_LINES (pathological only)

    // A single stderr line: progress lines drive the bar; everything else is
    // kept for the per-archive log so mongorestore's own output isn't silently
    // swallowed — except the duplicate-key torrent, which is counted, not kept.
    const consume = (line: string): void => {
      const p = parseProgress(line);

      if (p) {
        opts.onProgress?.(p);
        return;
      }

      // Duplicate _id is expected (idempotent restore, no --stopOnError) and
      // emitted once per skipped doc — billions on a full re-restore. Collapse
      // to a count + one example so it can never grow the heap. Retaining each
      // line was the OOM. Every OTHER line is kept (a genuine write failure or
      // corruption must stay visible, not hide behind the dup noise).
      if (DUP_KEY_RE.test(line)) {
        if (! dupKeyErrors) firstDupKey = line.trim();

        dupKeyErrors++;
        return;
      }

      if (line.trim()) {
        if (logLines.length < MAX_LOG_LINES) logLines.push(line);
        else                                 droppedLines++;
      }

      const docs = parseDoneLine(line);

      if (docs !== null) finishedDocs = docs;
    };

    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();

      stderrTail = (stderrTail + text).slice(-2048);
      buffer    += text;

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) consume(line);
    });

    proc.on('error', err => reject(new Error(`failed to spawn mongorestore: ${err.message}`)));

    // `close`, not `exit`: it fires only after stderr has fully drained, so the
    // final `N document(s) restored successfully` line has been parsed. `exit`
    // can fire first, leaving `finishedDocs` at 0 on an otherwise successful
    // restore. Flush any unterminated trailing line before deciding.
    proc.on('close', code => {
      if (buffer) consume(buffer);

      // End-of-run summary lines: the collapsed dup-key count (with one example)
      // and a loud marker if the unexpected-error cap was hit.
      if (dupKeyErrors > 0) {
        logLines.push(`${fmtNum(dupKeyErrors)} duplicate-key error(s) skipped (expected — idempotent restore). Example: ${firstDupKey}`);
      }

      if (droppedLines > 0) {
        logLines.push(`⚠ ${fmtNum(droppedLines)} further log line(s) omitted after the ${fmtNum(MAX_LOG_LINES)}-line cap — unexpected error volume, inspect this restore.`);
      }

      writeStderrLog(opts.logPath, logLines);

      if (code !== 0) {
        reject(new Error(`mongorestore exited ${code}: ${stderrTail.trim()}`));
        return;
      }

      resolve({ documents: finishedDocs, elapsedMs: Date.now() - start });
    });
  });
}

/** Persist mongorestore's non-progress stderr so its output is never invisible. Best-effort. */
function writeStderrLog(logPath: string | undefined, lines: string[]): void {
  if (! logPath || lines.length === 0) return;

  try {
    fs.writeFileSync(logPath, lines.join('\n') + '\n');
  } catch {
    /* never fail a restore over its log */
  }
}

function parseProgress(line: string): MongoRestoreProgress | null {
  const m = line.match(PROGRESS_RE);

  if (! m) return null;

  return { done: sizeToBytes(parseFloat(m[1]), m[2]) };
}

function parseDoneLine(line: string): number | null {
  const m = line.match(DONE_RE);

  return m ? parseInt(m[1], 10) : null;
}

function sizeToBytes(value: number, unit: string): number {
  switch (unit) {
    case 'B':  return Math.round(value);
    case 'KB': return Math.round(value * 1024);
    case 'MB': return Math.round(value * 1024 * 1024);
    case 'GB': return Math.round(value * 1024 * 1024 * 1024);
    case 'TB': return Math.round(value * 1024 * 1024 * 1024 * 1024);
    default:   return Math.round(value);
  }
}

// ── test exports ─────────────────────────────────────────────────────────────

export const _test_parseProgress = parseProgress;
export const _test_parseDoneLine = parseDoneLine;
export const _test_sizeToBytes   = sizeToBytes;
