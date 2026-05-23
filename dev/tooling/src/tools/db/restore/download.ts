import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { info, success, warn } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { writeStatus, clearStatus } from '../utils/progress';
import { fmtElapsed } from '../utils/format';
import type { RestoreTarget } from './types';

const execFileAsync     = promisify(execFile);
const POLL_INTERVAL_MS  = 2000;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * For every target with a Mega source and no (or smaller-than-mega) local
 * file, run `mega-get` to download into the matching local collection dir.
 * Sequential — network-bound work overlaps poorly with itself; parallel
 * upload was easy because each spawn carried its own tag, but doubling down
 * on bandwidth doesn't speed up downloads.
 *
 * On successful download, the target's `local` field is mutated to reflect
 * the new on-disk file so the subsequent restore step sees it.
 */
export async function downloadMissing(targets: RestoreTarget[], outDir: string): Promise<void> {
  const needed = targets.filter(t => t.mega && ! t.local);

  if (needed.length === 0) return;

  info(`Downloading ${needed.length} archive${needed.length === 1 ? '' : 's'} from Mega…`);

  for (const [idx, target] of needed.entries()) {
    const localDir  = path.join(outDir, target.collection);
    const localPath = path.join(localDir, target.filename);
    const prefix    = `[${idx + 1}/${needed.length}] ${target.collection}/${target.filename}`;
    const start     = Date.now();

    fs.mkdirSync(localDir, { recursive: true });

    info(`${prefix} ← mega:${target.mega!.path}`);

    try {
      await getWithProgress(target.mega!.path, localDir, (pct, elapsedMs) => {
        const pctStr  = pct !== null ? `${pct.toFixed(1).padStart(5)}%` : 'starting…';
        const elapsed = fmtElapsed(elapsedMs / 1000);

        writeStatus(`  ${C.dim}${pctStr}  ${elapsed}${C.reset}`);
      });

      clearStatus();

      const size = fs.statSync(localPath).size;

      target.local = { path: localPath, size };
      success(`  downloaded · ${fmtElapsed((Date.now() - start) / 1000)}`);
    } catch (err) {
      clearStatus();

      const detail = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.toString().trim()
        ?? (err as Error).message;

      warn(`  mega-get failed: ${detail}`);
      // Leave target.local null; the restore step will skip it.
    }
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function getWithProgress(
  remotePath: string,
  localDir:   string,
  onProgress: (pct: number | null, elapsedMs: number) => void,
): Promise<void> {
  const start = Date.now();

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'mega-get',
      ['--print-tag-at-start', remotePath, `${localDir}/`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let tag:        string | null = null;
    let stdoutBuf  = '';
    let stderrTail = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();

      if (! tag) {
        const m = stdoutBuf.match(/Tag\s*=\s*(\d+)/);

        if (m) tag = m[1];
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1024);
    });

    const poll = setInterval(async () => {
      const elapsedMs = Date.now() - start;

      if (! tag) {
        onProgress(null, elapsedMs);
        return;
      }

      try {
        const { stdout } = await execFileAsync('mega-transfers', [
          '--only-downloads',
          '--col-separator=|',
          '--output-cols=TAG,PROGRESS',
        ]);

        for (const line of stdout.split('\n')) {
          const parts = line.split('|');

          if (parts[0] === tag) {
            const m = parts[1]?.match(/(\d+(?:\.\d+)?)\s*%/);

            if (m) {
              onProgress(parseFloat(m[1]), elapsedMs);
              return;
            }
          }
        }

        onProgress(null, elapsedMs);
      } catch {
        onProgress(null, elapsedMs);
      }
    }, POLL_INTERVAL_MS);

    proc.on('exit', code => {
      clearInterval(poll);

      if (code === 0) resolve();
      else            reject(new Error(`mega-get exited ${code}: ${stderrTail.trim()}`));
    });

    proc.on('error', err => {
      clearInterval(poll);
      reject(err);
    });
  });
}
