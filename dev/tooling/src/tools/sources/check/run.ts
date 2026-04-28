import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { info, warn, error, success, section, spacer } from '../../../shared/ui/logger';

// ── Entry point ───────────────────────────────────────────────────────────────

export function runCheck(
  vaultDir: string,
  scope:    string | null,
  isDryRun: boolean,
): void {
  const files = collectGzFiles(vaultDir, scope);

  if (files.length === 0) {
    warn('No .gz files found. Nothing to check.');
    return;
  }

  section(isDryRun ? 'GZ Health Check (dry-run)' : 'GZ Health Check');
  spacer();
  info(`Scanning ${vaultDir}${scope ? `/${scope}` : ''}…`);
  spacer();

  const corrupt: string[] = [];
  let count = 0;

  for (const f of files) {
    count++;

    const result = spawnSync('gzip', ['-t', f], { stdio: 'pipe' });

    if (result.status !== 0) {
      corrupt.push(f);
      error(`CORRUPT: ${f}`);
    }

    if (count % 100 === 0) {
      info(`  … ${count} files checked so far`);
    }
  }

  spacer();
  info(`Done. ${count} ${count === 1 ? 'file' : 'files'} checked.`);
  spacer();

  if (corrupt.length === 0) {
    success('All files healthy.');
    return;
  }

  warn(`${corrupt.length} corrupt ${corrupt.length === 1 ? 'file' : 'files'} found.`);
  spacer();

  if (isDryRun) {
    info('Dry-run — skipping recovery. Corrupt files:');

    for (const f of corrupt) {
      info(`  ${f}`);
    }

    return;
  }

  info('Running gzrecover on corrupt files…');
  spacer();

  for (const f of corrupt) {
    recoverFile(f);
  }
}

// ── File collection ───────────────────────────────────────────────────────────

function collectGzFiles(rootDir: string, scope: string | null): string[] {
  const root = scope ? path.join(rootDir, scope) : rootDir;

  if (! fs.existsSync(root)) {
    return [];
  }

  const stat = fs.statSync(root);

  if (stat.isFile()) {
    return isGzFile(path.basename(root)) ? [root] : [];
  }

  return walkGzFiles(root);
}

function walkGzFiles(dir: string): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkGzFiles(full));
    } else if (entry.isFile() && isGzFile(entry.name)) {
      results.push(full);
    }
  }

  return results.sort();
}

/** True for *.gz files but not gzrecover outputs (*.gz.*) or other derivatives. */
function isGzFile(name: string): boolean {
  return name.endsWith('.gz') && ! name.includes('.gz.');
}

// ── Recovery ──────────────────────────────────────────────────────────────────

function recoverFile(filePath: string): void {
  info(`Recovering: ${filePath}`);

  const result = spawnSync('gzrecover', [filePath], { stdio: 'pipe' });

  if (result.error) {
    error(`  gzrecover not available: ${result.error.message}`);
    return;
  }

  const recoveredPath = filePath + '.recovered';

  if (result.status === 0 && fs.existsSync(recoveredPath)) {
    success(`  Recovered → ${recoveredPath}`);
    return;
  }

  const stderr = result.stderr?.toString().trim();

  warn(`  Recovery failed${stderr ? `: ${stderr}` : ' (unknown reason)'}`);
}
