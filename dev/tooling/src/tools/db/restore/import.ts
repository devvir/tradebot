import { spawn } from 'node:child_process';
import { info, warn } from '../../../shared/ui/logger';
import { fmtNum, fmtElapsed } from '../utils/format';
import { ProgressBlock } from '../utils/progress-block';
import { getEnv } from '../../../shared/utils/env';
import { mongoUri } from '../utils/connect';
import type { Pair, PlanRow } from '../types';
import type {
  RestoreTarget,
  RestoreOutcome,
  MongoRestoreOptions,
  MongoRestoreProgress,
  MongoRestoreResult,
  ExecuteRestoreOptions,
} from './types';

const DEFAULT_CONCURRENCY = 4;

// mongorestore reports bytes restored (uncompressed BSON), while we only know
// the archive's compressed size. Empirically the gzip ratio for our BSON dumps
// runs roughly 5–10×; 8 is a reasonable middle estimate for the ProgressBlock
// denominator. Progress % will be approximate but visible — better than the
// 0% you'd get with no denominator.
const UNCOMPRESSED_RATIO_ESTIMATE = 8;

// mongorestore --verbose stderr formats:
//   progress (each ~3 s):  `<timestamp>\t<db>.<coll>  <value><unit>`   e.g.  `tradebot.quoteBin1h  10.4MB`
//   final summary:         `<N> document(s) restored successfully. <M> document(s) failed to restore.`
const PROGRESS_RE = /\s\S+\.\S+\s+(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)\s*$/;
const DONE_RE     = /(\d+)\s+document\(s\)\s+restored\s+successfully/i;

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
  const { nsFrom, nsTo } = options;

  let next = 0;

  async function worker(): Promise<void> {
    while (next < total) {
      const idx    = next++;
      const target = ready[idx];

      outcomes[idx] = await restoreOne(uri, target, idx, total, progress, nsFrom, nsTo);
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
  uri:      string,
  target:   RestoreTarget,
  idx:      number,
  total:    number,
  progress: ProgressBlock,
  nsFrom?:  string,
  nsTo?:    string,
): Promise<RestoreOutcome> {
  const prefix = `[${idx + 1}/${total}] ${target.collection} [${target.key}]`;
  const start  = Date.now();

  // ProgressBlock measures `done / row.count`. mongorestore's running counter
  // is restored bytes, so we estimate the uncompressed total as
  // compressedSize × UNCOMPRESSED_RATIO_ESTIMATE. Both `done` and `count`
  // are now in bytes — the block's fmtCount renders them as "10.4M"/"30.0M"
  // which in this context reads as MB.
  const pair: Pair    = { collection: target.collection, date: null };
  const expectedBytes = target.local!.size * UNCOMPRESSED_RATIO_ESTIMATE;
  const row:  PlanRow = { ...pair, count: expectedBytes, avgObjSize: 0 };
  const key           = `restore|${target.collection}|${target.key}`;

  progress.pairStart(key, idx, row);

  try {
    const result = await runMongoRestore({
      uri,
      archivePath: target.local!.path,
      nsFrom,
      nsTo,
      onProgress:  p => progress.pairUpdate(key, p.done),
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

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048);
      buffer    += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const p = parseProgress(line);

        if (p) {
          opts.onProgress?.(p);
          continue;
        }

        const docs = parseDoneLine(line);

        if (docs !== null) finishedDocs = docs;
      }
    });

    proc.on('error', err => reject(new Error(`failed to spawn mongorestore: ${err.message}`)));

    proc.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`mongorestore exited ${code}: ${stderrTail.trim()}`));
        return;
      }

      resolve({ documents: finishedDocs, elapsedMs: Date.now() - start });
    });
  });
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
