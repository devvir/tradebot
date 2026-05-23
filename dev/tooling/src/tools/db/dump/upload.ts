import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import inquirer from 'inquirer';
import { getEnv } from '../../../shared/utils/env';
import { info, success, warn, spacer } from '../../../shared/ui/logger';
import { C } from '../../../shared/utils/colors';
import { posixJoin, isMegaUnavailable } from '../utils/mega';
import { syncStatesForCollections, listLocalCollections } from '../utils/sync';
import { writeStatus, clearStatus } from '../utils/progress';
import { fmtElapsed } from '../utils/format';
import { fmtBytes } from '../../../shared/utils/format';
import type { PendingUpload, UploadMismatch, UploadVerification } from './types';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 2000;
const PREVIEW_LIMIT    = 20;

// ── Exports ──────────────────────────────────────────────────────────────────

/**
 * Diff `<outDir>/<collection>/*.archive.gz` against each collection's Mega
 * listing, offer to upload anything that's local-but-not-on-Mega, then verify
 * sizes and offer to clean up the local copies of verified uploads.
 *
 * Runs independently of whether a dump just executed — picks up files left
 * behind from a previous run where the user skipped the upload step.
 *
 * Silently returns if `DB_DUMP_MEGA_DIR` is unset, mega-cmd is unavailable,
 * `outDir` is empty, or everything is already on Mega.
 */
export async function maybeUploadToMega(outDir: string): Promise<void> {
  const megaBase = getEnv('DB_DUMP_MEGA_DIR');

  if (! megaBase)        return;
  if (isMegaUnavailable()) return;

  const collections = listLocalCollections(outDir);

  if (collections.length === 0) return;

  const states  = await syncStatesForCollections(collections, outDir, megaBase);
  const pending = states
    .filter(s => s.local && ! s.mega)
    .map(s => ({ collection: s.collection, file: s.file, localPath: s.local!.path }));

  if (pending.length === 0) return;

  spacer();
  console.log(`Mega backup target: ${C.cyan}${megaBase}${C.reset}`);
  console.log(`${pending.length} file${pending.length === 1 ? '' : 's'} on local not yet on Mega:`);

  for (const item of pending.slice(0, PREVIEW_LIMIT)) {
    console.log(`  ${item.collection}/${item.file}`);
  }

  if (pending.length > PREVIEW_LIMIT) {
    console.log(`  ${C.dim}… and ${pending.length - PREVIEW_LIMIT} more${C.reset}`);
  }

  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'upload',
    message: `Upload ${pending.length} file${pending.length === 1 ? '' : 's'} to Mega?`,
    default: true,
  }]);

  if (! answer.upload) {
    info('Skipped Mega upload.');
    return;
  }

  spacer();
  info(`Uploading ${pending.length} file${pending.length === 1 ? '' : 's'} to Mega…`);

  const uploaded: PendingUpload[] = [];
  let   fail     = 0;

  for (const [idx, item] of pending.entries()) {
    const megaDir = posixJoin(megaBase, item.collection);
    const prefix  = `[${idx + 1}/${pending.length}] ${item.collection}/${item.file}`;
    const start   = Date.now();

    info(`${prefix} → mega:${megaDir}/`);

    try {
      await uploadWithProgress(item.localPath, megaDir, (pct, elapsedMs) => {
        const pctStr  = pct !== null ? `${pct.toFixed(1).padStart(5)}%` : 'starting…';
        const elapsed = fmtElapsed(elapsedMs / 1000);

        writeStatus(`  ${C.dim}${pctStr}  ${elapsed}${C.reset}`);
      });

      clearStatus();
      success(`  uploaded · ${fmtElapsed((Date.now() - start) / 1000)}`);
      uploaded.push(item);
    } catch (err) {
      clearStatus();

      const detail = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.toString().trim()
        ?? (err as Error).message;

      warn(`  mega-put failed: ${detail}`);
      fail++;
    }
  }

  spacer();

  if (fail === 0) {
    success(`Backed up ${uploaded.length}/${pending.length} file${uploaded.length === 1 ? '' : 's'} to Mega`);
  } else {
    warn(`Mega backup: ${uploaded.length} ok, ${fail} failed — re-run to retry`);
  }

  if (uploaded.length === 0) return;

  // Verify byte-for-byte that what's on Mega matches what we just uploaded.
  // If anything's off, skip the cleanup prompt entirely — the user should
  // investigate before deleting their only copy.
  const verification = await verifyUploadsOnMega(uploaded, outDir, megaBase);

  if (verification.mismatched.length > 0) {
    printMismatches(verification.mismatched);
    warn('Skipping cleanup prompt — investigate the mismatches above, then re-run if you still want to clean up.');
    return;
  }

  await promptCleanupUploaded(verification.verified);
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Compare each successfully-uploaded local file's size against Mega's copy
 * via the shared sync-state helper (one mega-ls per collection in parallel).
 */
async function verifyUploadsOnMega(
  uploaded: PendingUpload[],
  outDir:   string,
  megaBase: string,
): Promise<UploadVerification> {
  const collections = [...new Set(uploaded.map(u => u.collection))];
  const states      = await syncStatesForCollections(collections, outDir, megaBase);

  const stateByKey = new Map<string, typeof states[number]>();

  for (const s of states) stateByKey.set(`${s.collection}|${s.file}`, s);

  const verified:   PendingUpload[]  = [];
  const mismatched: UploadMismatch[] = [];

  for (const item of uploaded) {
    const state     = stateByKey.get(`${item.collection}|${item.file}`);
    const localSize = state?.local?.size ?? 0;
    const megaSize  = state?.mega?.size;

    if      (megaSize === undefined) mismatched.push({ item, local: localSize, mega: null });
    else if (megaSize !== localSize) mismatched.push({ item, local: localSize, mega: megaSize });
    else                             verified.push(item);
  }

  return { verified, mismatched };
}

function printMismatches(mismatched: UploadMismatch[]): void {
  spacer();
  warn(`${mismatched.length} file${mismatched.length === 1 ? '' : 's'} did not verify on Mega:`);

  for (const m of mismatched) {
    const megaInfo = m.mega === null ? `${C.yellow}missing on Mega${C.reset}` : `mega=${fmtBytes(m.mega)}`;

    console.log(`  ${m.item.collection}/${m.item.file}   local=${fmtBytes(m.local)}   ${megaInfo}`);
  }
}

async function promptCleanupUploaded(verified: PendingUpload[]): Promise<void> {
  if (verified.length === 0) return;

  spacer();

  const answer = await inquirer.prompt([{
    type:    'confirm',
    name:    'remove',
    message: `Remove ${verified.length} uploaded archive${verified.length === 1 ? '' : 's'} from local?`,
    default: false,
  }]);

  if (! answer.remove) return;

  let removed = 0;

  for (const item of verified) {
    try {
      fs.unlinkSync(item.localPath);
      removed++;
    } catch (err) {
      warn(`Could not remove ${item.localPath}: ${(err as Error).message}`);
    }
  }

  success(`Removed ${removed}/${verified.length} local archive${removed === 1 ? '' : 's'}`);
}

/**
 * Spawn `mega-put`, capture the transfer tag from its stdout, and poll
 * `mega-transfers` every POLL_INTERVAL_MS for live progress on that tag.
 */
function uploadWithProgress(
  localPath:  string,
  remoteDir:  string,
  onProgress: (pct: number | null, elapsedMs: number) => void,
): Promise<void> {
  const start = Date.now();

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'mega-put',
      ['-c', '--print-tag-at-start', localPath, `${remoteDir}/`],
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
          '--only-uploads',
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
      else            reject(new Error(`mega-put exited ${code}: ${stderrTail.trim()}`));
    });

    proc.on('error', err => {
      clearInterval(poll);
      reject(err);
    });
  });
}
