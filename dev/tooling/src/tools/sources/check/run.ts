import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { error, info, section, spacer, success, warn } from '../log';
import { resolveSourceFiles } from '../discover';
import { isDryRun } from '../options';

const execFileAsync = promisify(execFile);

// ── gzip / gzrecover wrappers ─────────────────────────────────────────────────

async function isCorrupt(filePath: string): Promise<boolean> {
  try {
    await execFileAsync('gzip', ['-t', filePath]);

    return false;
  } catch {
    return true;
  }
}

async function recover(filePath: string): Promise<void> {
  const ext     = '.csv.gz';
  const base    = filePath.endsWith(ext) ? filePath.slice(0, -ext.length) : filePath;
  const outPath = `${base}.recovered${ext}`;

  await execFileAsync('gzrecover', ['-o', outPath, filePath]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * `sources check` orchestrator. Tests every `.csv.gz` resolved from `root`
 * with `gzip -t` and (unless dry-run) recovers corrupt files via `gzrecover`.
 */
export async function runCheck(root: string): Promise<void> {
  const files = resolveSourceFiles(root);

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
    if (! await isCorrupt(file)) {
      ok++;
      continue;
    }

    corrupt++;
    warn(`Corrupt: ${file}`);

    if (isDryRun()) continue;

    try {
      await recover(file);
      info(`  Recovered → ${path.basename(file, '.csv.gz')}.recovered.csv.gz`);
      recovered++;
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
