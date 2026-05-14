import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { C } from '../../../shared/utils/colors';
import { confirmYNA } from '../../../shared/ui/prompts';
import { info, spacer, success, warn } from '../log';
import { concurrency, fromDay, isYes } from '../options';
import { printPreview } from './display';
import { spawn } from 'node:child_process';
import { refreshLocal, scanAll } from '../scan';
import { VaultState } from '../scan/types';
import { deriveTasks } from './tasks';
import {
  BackupBucketFile,
  BackupBucketTask,
  BackupSourceFile,
  BackupSourceTask,
  CleanRsyncTempsTask,
  CleanupLocalFile,
  CleanupRemoteFile,
  CleanupTask,
  PrepareTask,
  PullTask,
  Task,
} from './types';

const execFileAsync = promisify(execFile);

/**
 * Walks the task list, showing a short preview of each task and prompting the
 * user. Y = run the task, N = skip it, A = accept all remaining.
 *
 * With `-y` / `--yes` set, all prompts are auto-accepted.
 */
export async function runInteractive(tasks: Task[], state: VaultState): Promise<void> {
  if (tasks.length === 0) return;

  let acceptAll = false;

  for (let i = 0; i < tasks.length; i++) {
    const predicted = tasks[i]!;
    const task      = await liveTaskFor(predicted, state);

    spacer();
    console.log(`${C.bold}${C.cyan}── Task ${i + 1} / ${tasks.length} ── ${taskLabel(task ?? predicted)} ──${C.reset}`);
    spacer();

    if (! task) {
      info('Nothing to do based on current disk state.');
      continue;
    }

    printPreview(task);
    spacer();

    if (task.isAbnormal) {
      warn(`⚠ ${task.abnormalWarning}`);
    }

    const unattended = isYes() || acceptAll;

    if (unattended && task.isAbnormal) {
      warn(`Skipped (unattended + review required): ${taskLabel(task)}`);
      continue;
    }

    if (unattended) {
      await execute(task, state.config.localBase);
      continue;
    }

    const choice = await confirmYNA('Run this task?', task.isAbnormal ? 'no' : 'yes');

    if (choice === 'no') {
      warn(`Skipped: ${taskLabel(task)}`);
      continue;
    }

    if (choice === 'all') {
      info('Auto-accepting all remaining tasks.');
      acceptAll = true;
    }

    await execute(task, state.config.localBase);
  }
}

/**
 * Produces the *live* version of a predicted task right before it's about
 * to be shown / run. For tasks that consume the output of earlier tasks
 * (backup-source / prepare / backup-bucket), we re-scan local disk and
 * re-derive in `live` mode — so phantom files from skipped or stubbed prior
 * tasks naturally drop out. Cleanup needs remote+Mega truth too, so it does
 * a full re-scan. Pull and the rsync-temp sweep don't depend on other tasks
 * and pass through unchanged.
 *
 * Returns `null` when the freshened state leaves nothing to do for that task.
 */
async function liveTaskFor(predicted: Task, state: VaultState): Promise<Task | null> {
  if (predicted.kind === 'backup-source'
      || predicted.kind === 'prepare'
      || predicted.kind === 'backup-bucket') {
    refreshLocal(state);

    return deriveTasks(state, 'live').find(t => t.kind === predicted.kind) ?? null;
  }

  if (predicted.kind === 'cleanup') {
    info('Re-scanning to verify pipeline results …');
    const fresh = await scanAll(state.config);

    return deriveTasks(fresh, 'live').find(t => t.kind === 'cleanup') ?? null;
  }

  return predicted;
}

// ── Execution ─────────────────────────────────────────────────────────────────

async function execute(task: Task, localBase: string): Promise<void> {
  if (task.kind === 'clean-rsync-temps') {
    await executeCleanRsyncTemps(task);

    return;
  }

  if (task.kind === 'pull') {
    await executePull(task);

    return;
  }

  if (task.kind === 'backup-source') {
    await executeBackupSource(task);

    return;
  }

  if (task.kind === 'prepare') {
    await executePrepare(task, localBase);

    return;
  }

  if (task.kind === 'backup-bucket') {
    await executeBackupBucket(task);

    return;
  }

  if (task.kind === 'cleanup') {
    await executeCleanup(task);

    return;
  }
}

async function executeCleanRsyncTemps(task: CleanRsyncTempsTask): Promise<void> {
  let ok   = 0;
  let fail = 0;

  for (const file of task.files) {
    try {
      fs.unlinkSync(file.absPath);
      ok++;
    } catch (err) {
      warn(`Failed to remove ${file.filename}: ${(err as Error).message}`);
      fail++;
    }
  }

  if (fail === 0) {
    success(`Removed ${ok} rsync temp file${ok === 1 ? '' : 's'}`);
  } else {
    warn(`Removed ${ok}, failed to remove ${fail} — check permissions`);
  }
}

async function executePull(task: PullTask): Promise<void> {
  info(`Pulling ${task.files.length} file${task.files.length === 1 ? '' : 's'} from ${task.remote} …`);

  let ok   = 0;
  let fail = 0;

  for (const file of task.files) {
    info(`  ${file.table}/${file.year}/${file.day}.${file.suffix}.csv.gz`);
    fs.mkdirSync(path.dirname(file.localPath), { recursive: true });

    try {
      await execFileAsync('rsync', ['-az', '--ignore-existing', file.remotePath, file.localPath]);
      ok++;
    } catch (err) {
      const detail = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.toString().trim()
        ?? (err as Error).message;

      warn(`rsync failed: ${file.remotePath}\n  ${detail}`);
      fail++;
    }
  }

  if (fail === 0) {
    success(`Pulled ${ok} file${ok === 1 ? '' : 's'} from ${task.remote}`);
  } else {
    warn(`Pull from ${task.remote}: ${ok} ok, ${fail} failed — re-run to retry`);
  }
}

async function executeBackupSource(task: BackupSourceTask): Promise<void> {
  info(`Backing up ${task.files.length} source file${task.files.length === 1 ? '' : 's'} to Mega …`);

  const uploaded: BackupSourceFile[] = [];
  let uploadFail = 0;

  for (const file of task.files) {
    info(`  ${file.table}/${file.year}/${file.day}.${file.suffix}.csv.gz`);

    const megaDir = path.dirname(file.megaPath);

    try {
      await execFileAsync('mega-put', ['-c', file.localPath, megaDir]);
      uploaded.push(file);
    } catch (err) {
      const detail = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.toString().trim()
        ?? (err as Error).message;

      warn(`mega-put failed: ${file.localPath}\n  ${detail}`);
      uploadFail++;
    }
  }

  if (uploaded.length > 0) info('Verifying uploads …');

  const verifyFail = await verifyMegaUploads(uploaded);
  const ok         = uploaded.length - verifyFail;
  const fail       = uploadFail + verifyFail;

  if (fail === 0) {
    success(`Backed up ${ok} source file${ok === 1 ? '' : 's'} to Mega`);
  } else {
    warn(`Backup sources: ${ok} ok, ${fail} failed — re-run to retry`);
  }
}

async function executePrepare(_task: PrepareTask, localBase: string): Promise<void> {
  // Spawn `data prepare <localBase>` as a subprocess so its output streams
  // live to the terminal and a non-zero exit code doesn't kill data sync.
  const args: string[] = ['data'];

  if (concurrency() > 1) args.push('-C', String(concurrency()));

  const from = fromDay();

  if (from) args.push('--from', from);

  args.push('prepare', localBase);

  return new Promise(resolve => {
    const child = spawn(process.argv[0]!, [process.argv[1]!, ...args], {
      stdio: 'inherit',
    });

    child.on('error', err => {
      warn(`Failed to start prepare: ${err.message}`);
      resolve();
    });

    child.on('close', code => {
      if (code !== 0 && code !== null) {
        warn(`Prepare exited with code ${code} — some days may not have been prepared; re-run to retry`);
      }

      resolve();
    });
  });
}

async function executeBackupBucket(task: BackupBucketTask): Promise<void> {
  info(`Backing up ${task.files.length} bucket file${task.files.length === 1 ? '' : 's'} to Mega …`);

  const uploaded: BackupBucketFile[] = [];
  let uploadFail = 0;
  let skipped    = 0;

  for (const file of task.files) {
    if (! fs.existsSync(file.localPath)) {
      info(`  ${file.table}/${file.year}/${file.day}.csv.gz ${C.dim}(skipped — not on disk yet)${C.reset}`);
      skipped++;
      continue;
    }

    info(`  ${file.table}/${file.year}/${file.day}.csv.gz`);

    const megaDir = path.dirname(file.megaPath);

    try {
      await execFileAsync('mega-put', ['-c', file.localPath, megaDir]);
      uploaded.push(file);
    } catch (err) {
      const detail = (err as NodeJS.ErrnoException & { stderr?: string }).stderr?.toString().trim()
        ?? (err as Error).message;

      warn(`mega-put failed: ${file.localPath}\n  ${detail}`);
      uploadFail++;
    }
  }

  if (uploaded.length > 0) info('Verifying uploads …');

  const verifyFail = await verifyMegaUploads(uploaded);
  const ok         = uploaded.length - verifyFail;
  const fail       = uploadFail + verifyFail;

  if (fail === 0 && skipped === 0) {
    success(`Backed up ${ok} bucket file${ok === 1 ? '' : 's'} to Mega`);
  } else if (fail === 0) {
    success(`Backed up ${ok}, skipped ${skipped} (not on disk — earlier step skipped or failed)`);
  } else {
    warn(`Backup buckets: ${ok} ok, ${skipped} skipped, ${fail} failed — re-run to retry`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function executeCleanup(task: CleanupTask): Promise<void> {
  info(`Moving ${task.files.length} source file${task.files.length === 1 ? '' : 's'} to .trash …`);

  let ok      = 0;
  let fail    = 0;
  let missing = 0;

  let mismatch = 0;

  for (const file of task.files) {
    const tag = file.location === 'local' ? 'local      ' : `${file.remote}`.padEnd(11);

    info(`  ${C.dim}${tag}${C.reset}  ${file.table}/${file.year}/${file.day}.${file.suffix}.csv.gz`);

    const result = file.location === 'local'
      ? trashLocal(file)
      : await trashRemote(file);

    if (result.outcome === 'moved')   ok++;
    if (result.outcome === 'missing') missing++;

    if (result.outcome === 'size-mismatch') {
      warn(`  ${C.red}size mismatch${C.reset}: remote ${result.remoteSize} B, local ${result.localSize} B — skipped`);
      mismatch++;
    }

    if (result.outcome === 'error') {
      warn(`  ${C.red}failed${C.reset}: ${result.error}`);
      fail++;
    }
  }

  const problems = fail + mismatch;

  if (problems === 0 && missing === 0) {
    success(`Moved ${ok} source file${ok === 1 ? '' : 's'} to .trash`);
  } else if (problems === 0) {
    success(`Moved ${ok}, skipped ${missing} (not on disk — earlier step skipped or failed)`);
  } else {
    const parts = [
      `${ok} moved`,
      missing   > 0 ? `${missing} skipped`   : '',
      mismatch  > 0 ? `${mismatch} size mismatch` : '',
      fail      > 0 ? `${fail} failed`        : '',
    ].filter(Boolean).join(', ');

    warn(`Cleanup: ${parts} — re-run to retry`);
  }
}

type CleanupResult =
  | { outcome: 'moved';          dest: string }
  | { outcome: 'missing' }
  | { outcome: 'size-mismatch';  remoteSize: number; localSize: number }
  | { outcome: 'error';          error: string };

function trashLocal(file: CleanupLocalFile): CleanupResult {
  if (! fs.existsSync(file.absPath)) return { outcome: 'missing' };

  const localBase = inferLocalBase(file);
  const trashDir  = path.join(localBase, '.trash', file.table, file.year);

  try {
    fs.mkdirSync(trashDir, { recursive: true });
  } catch (err) {
    return { outcome: 'error', error: `mkdir ${trashDir}: ${(err as Error).message}` };
  }

  const dest = nextFreeTrashPath(trashDir, `${file.day}.${file.suffix}`, '.csv.gz');

  try {
    fs.renameSync(file.absPath, dest);

    return { outcome: 'moved', dest };
  } catch (err) {
    return { outcome: 'error', error: `mv → ${dest}: ${(err as Error).message}` };
  }
}

/**
 * Recovers the local vault root from a `CleanupLocalFile` by stripping the
 * trailing `<table>/<year>/<file>` portion of `absPath`. Saves us from
 * threading `ScanConfig` through the task object.
 */
function inferLocalBase(file: CleanupLocalFile): string {
  return path.dirname(path.dirname(path.dirname(file.absPath)));
}

function nextFreeTrashPath(dir: string, base: string, ext: string): string {
  let candidate = path.join(dir, base + ext);

  if (! fs.existsSync(candidate)) return candidate;

  let n = 1;

  while (true) {
    candidate = path.join(dir, `${base}.${n}${ext}`);

    if (! fs.existsSync(candidate)) return candidate;
    n++;
  }
}

async function trashRemote(file: CleanupRemoteFile): Promise<CleanupResult> {
  const trashDir  = `${file.remoteBase}/.trash/${file.table}/${file.year}`;
  const base      = `${file.day}.${file.suffix}`;
  const ext       = '.csv.gz';
  const target    = `${file.user}@${file.host}`;
  const localSize = file.localPath && fs.existsSync(file.localPath)
    ? fs.statSync(file.localPath).size
    : 0;

  // Single SSH call:
  //   - exit 100 → source missing
  //   - exit 101 → size mismatch vs local copy (stdout: "SIZEMISMATCH:<remoteBytes>")
  //   - exit 0   → success (stdout: destination path)
  const script = [
    'set -e',
    `src='${file.remotePath}'`,
    `dir='${trashDir}'`,
    `base='${base}'`,
    `ext='${ext}'`,
    `local_size=${localSize}`,
    'if [ ! -e "$src" ]; then exit 100; fi',
    'if [ "$local_size" -gt 0 ]; then',
    '  remote_size=$(stat -c %s "$src")',
    '  if [ "$remote_size" != "$local_size" ]; then',
    '    printf "SIZEMISMATCH:%s" "$remote_size"',
    '    exit 101',
    '  fi',
    'fi',
    'mkdir -p "$dir"',
    'dst="$dir/$base$ext"',
    'n=1',
    'while [ -e "$dst" ]; do dst="$dir/$base.$n$ext"; n=$((n+1)); done',
    'mv "$src" "$dst"',
    'printf "%s" "$dst"',
  ].join('\n');

  return new Promise(resolve => {
    const child = spawn('ssh', [target, 'bash', '-s']);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('error', err => {
      resolve({ outcome: 'error', error: `ssh ${target}: ${err.message}` });
    });

    child.on('close', code => {
      if (code === 0)   { resolve({ outcome: 'moved', dest: stdout.trim() }); return; }
      if (code === 100) { resolve({ outcome: 'missing' });                     return; }

      if (code === 101) {
        const remoteSize = parseInt(stdout.replace('SIZEMISMATCH:', ''), 10);

        resolve({ outcome: 'size-mismatch', remoteSize, localSize });
        return;
      }

      resolve({ outcome: 'error', error: stderr.trim() || `exit ${code}` });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

// ── Mega upload verification ──────────────────────────────────────────────────

/**
 * Verifies a batch of just-uploaded files by running one `mega-ls -l` per
 * unique destination directory, then comparing the Mega-reported size of each
 * file against its local size.
 *
 * Returns the number of files that failed verification (not found in Mega, or
 * size mismatch). Warnings are printed inline for each failure.
 */
async function verifyMegaUploads(
  files: Array<{ localPath: string; megaPath: string }>,
): Promise<number> {
  const byDir = new Map<string, Array<{ localPath: string; megaPath: string }>>();

  for (const f of files) {
    const dir = path.dirname(f.megaPath);
    const arr = byDir.get(dir);

    if (arr) {
      arr.push(f);
    } else {
      byDir.set(dir, [f]);
    }
  }

  let failures = 0;

  for (const [dir, dirFiles] of byDir) {
    let sizes: Map<string, number>;

    try {
      sizes = await listMegaDirSizes(dir);
    } catch (err) {
      warn(`mega-ls failed for ${dir}: ${(err as Error).message} — could not verify uploads`);
      failures += dirFiles.length;
      continue;
    }

    for (const f of dirFiles) {
      const filename = path.basename(f.megaPath);
      const megaSize = sizes.get(filename);

      let localSize: number;

      try {
        localSize = fs.statSync(f.localPath).size;
      } catch {
        warn(`  ${C.red}verify failed${C.reset}: ${filename} — local file no longer on disk`);
        failures++;
        continue;
      }

      if (megaSize === undefined) {
        warn(`  ${C.red}verify failed${C.reset}: ${filename} — not found in Mega after upload`);
        failures++;
      } else if (megaSize !== localSize) {
        warn(`  ${C.red}verify failed${C.reset}: ${filename} — size mismatch (local ${localSize} B, Mega ${megaSize} B)`);
        failures++;
      }
    }
  }

  return failures;
}

/**
 * Runs `mega-ls -l <dir>` and returns a filename → byte-size map.
 *
 * mega-ls -l format: FLAGS  VERS  SIZE  DATE  TIME  NAME
 * FLAGS = 4-char string, VERS = version count (typically 1), SIZE = bytes.
 * Last field is NAME; we require ≥ 6 fields to avoid matching header/dirs.
 */
async function listMegaDirSizes(dir: string): Promise<Map<string, number>> {
  const { stdout } = await execFileAsync('mega-ls', ['-l', dir]);
  const result     = new Map<string, number>();

  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 6)           continue;
    if (! /^\d+$/.test(parts[2]!))  continue;   // skip header and dirs (SIZE at index 2)

    result.set(parts[parts.length - 1]!, parseInt(parts[2]!, 10));
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function taskLabel(task: Task): string {
  if (task.kind === 'clean-rsync-temps') return 'Remove rsync temp files';
  if (task.kind === 'pull')              return `Pull from ${task.remote}`;
  if (task.kind === 'backup-source')     return 'Back up sources to Mega';
  if (task.kind === 'prepare')           return 'Prepare source files';
  if (task.kind === 'backup-bucket')     return 'Back up buckets to Mega';

  return 'Move completed sources to .trash';
}
