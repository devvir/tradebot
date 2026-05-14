import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { error, info, section, spacer, success, warn } from '../log';
import { resolveCsvGzFiles } from '../discover';
import { isDryRun } from '../options';

const execFileAsync = promisify(execFile);

/** A line that opens with a complete ISO `_date_` field, e.g. `2026-04-11T00:00:00.020Z,`. */
const TIMESTAMP_LINE_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z,';

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
 * Decompresses a corrupt `.csv.gz` with gzrecover. gzrecover emits the raw
 * *content* — plain CSV text, not a gzip — so the output keeps a `.csv`
 * extension.
 */
async function recover(filePath: string): Promise<string> {
  const ext     = '.csv.gz';
  const base    = filePath.endsWith(ext) ? filePath.slice(0, -ext.length) : filePath;
  const outPath = `${base}.recovered.csv`;

  await execFileAsync('gzrecover', ['-o', outPath, filePath]);

  return outPath;
}

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

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * `data recover` orchestrator. Tests every `.csv.gz` resolved from `root`
 * with `gzip -t` and (unless dry-run) recovers corrupt files via `gzrecover`,
 * then prunes the scrambled tail gzrecover leaves behind.
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

    let outPath: string;

    try {
      outPath = await recover(file);
      recovered++;
    } catch (err) {
      error(`  Recovery failed: ${(err as Error).message}`);
      failed++;
      continue;
    }

    try {
      const result = await pruneScrambledTail(outPath);

      if (result === 'no-timestamp') {
        warn(`  Recovered → ${path.basename(outPath)} — no valid timestamp found, not pruned`);
      } else {
        info(`  Recovered & pruned → ${path.basename(outPath)}`);
      }
    } catch (err) {
      warn(`  Recovered → ${path.basename(outPath)} — prune failed: ${(err as Error).message}`);
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

// ── Test-only exports ─────────────────────────────────────────────────────────

export const _test_isCorrupt           = isCorrupt;
export const _test_recover             = recover;
export const _test_pruneScrambledTail  = pruneScrambledTail;
export const _test_lastTimestampOffset = lastTimestampOffset;
