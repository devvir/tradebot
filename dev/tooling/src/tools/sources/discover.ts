import fs from 'node:fs';
import path from 'node:path';
import type { FilePair } from './types.js';

const WS_FILE_PATTERN = /\/(announcement|chat|connected|instrument|liquidation|orderBookL2|publicNotifications)\/\d{4}\/[^/]+\.csv\.gz$/;

/**
 * Derive the gaps root directory from the vault root directory.
 * Replaces the last occurrence of "/vault" in the path with "/gaps".
 */
export function gapsDirFromVaultDir(vaultDir: string): string {
  const normalised = vaultDir.replace(/\/$/, '');
  const idx = normalised.lastIndexOf('/vault');

  if (idx === -1) {
    throw new Error(
      `Cannot derive gaps directory: VAULT_DATA_DIR does not contain "/vault".\n` +
      `  VAULT_DATA_DIR = ${vaultDir}`,
    );
  }

  return normalised.slice(0, idx) + '/gaps' + normalised.slice(idx + '/vault'.length);
}

/**
 * Recursively collect all .csv and .csv.gz files under a directory,
 * optionally filtered by a relative scope path.
 *
 * Scope may be:
 *  - empty / null         → entire directory
 *  - "instrument"         → only files under that table sub-directory
 *  - "instrument/2026"    → only files under that year sub-directory
 *  - "instrument/2026/20261102.csv.gz" → exactly that file
 */
/**
 * Scope supports partial matching:
 *  - "instrument"                    → all files under instrument/
 *  - "instrument/2026"              → all files under instrument/2026/
 *  - "instrument/2026/20261102"     → any file whose name starts with 20261102
 *  - "chat/2026/202602"            → any file whose name starts with 202602
 *  - "instrument/2026/20261102.csv" → that exact file
 */
export function collectFiles(rootDir: string, scope: string | null): string[] {
  if (! scope) {
    return fs.existsSync(rootDir) ? walkDir(rootDir) : [];
  }

  const fullPath = path.join(rootDir, scope);

  // Exact file match
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    return isSupportedFile(fullPath) ? [fullPath] : [];
  }

  // Exact directory match
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    return walkDir(fullPath);
  }

  // Partial filename match: scope is a prefix within its parent directory
  const parentDir = path.join(rootDir, path.dirname(scope));
  const prefix = path.basename(scope);

  if (! fs.existsSync(parentDir) || ! fs.statSync(parentDir).isDirectory()) {
    return [];
  }

  return walkDir(parentDir).filter(f => path.basename(f).startsWith(prefix));
}

/**
 * Build FilePair objects by pairing each gaps file with its vault counterpart.
 *
 * - Gaps files that have no matching vault file are skipped (returns null in
 *   the corresponding slot — callers filter these out and warn).
 * - Output path is always in the vault directory, with the extension
 *   replaced by .merged.csv.gz.
 */
export function buildFilePairs(
  vaultDir: string,
  gapsDir: string,
  gapsFiles: string[],
): Array<FilePair | null> {
  return gapsFiles.map(gapsPath => {
    const rel = path.relative(gapsDir, gapsPath);
    const vaultPath = resolveVaultPath(vaultDir, rel);

    if (! vaultPath) {
      return null;
    }

    const tableName = rel.split(path.sep)[0] ?? 'unknown';
    const outputPath = buildOutputPath(vaultDir, rel);

    return { basePath: vaultPath, gapsPath, outputPath, tableName };
  });
}

/**
 * Build a FilePair for a single vault file (no gaps counterpart).
 * Used when a scope is given and no gaps file is required.
 */
export function buildSingleFilePair(
  vaultDir: string,
  vaultPath: string,
): FilePair {
  const rel = path.relative(vaultDir, vaultPath);
  const tableName = rel.split(path.sep)[0] ?? 'unknown';
  const outputPath = buildOutputPath(vaultDir, rel);

  return { basePath: vaultPath, gapsPath: null, outputPath, tableName };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile() && isSupportedFile(full)) {
      results.push(full);
    }
  }

  return results;
}

function isSupportedFile(filePath: string): boolean {
  return WS_FILE_PATTERN.test(filePath);
}

/** Find a vault file matching a relative path, trying .csv.gz then .csv. */
function resolveVaultPath(vaultDir: string, rel: string): string | null {
  const candidate = path.join(vaultDir, stripExtension(rel) + '.csv.gz');

  return fs.existsSync(candidate) ? candidate : null;
}

function stripExtension(filePath: string): string {
  return filePath.endsWith('.csv.gz') ? filePath.slice(0, -'.csv.gz'.length) : filePath;
}

function buildOutputPath(vaultDir: string, rel: string): string {
  const withoutExt = stripExtension(rel);
  return path.join(vaultDir, withoutExt + '.merged.csv.gz');
}
