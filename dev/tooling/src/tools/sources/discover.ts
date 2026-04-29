import fs from 'node:fs';
import path from 'node:path';
import type { SourceFile } from './types.js';

const WS_FILE_PATTERN    = /\/(announcement|chat|connected|instrument|liquidation|orderBookL2|publicNotifications)\/\d{4}\/[^/]+\.csv\.gz$/;
const TABLE_NAME_PATTERN = /\/(announcement|chat|connected|instrument|liquidation|orderBookL2|publicNotifications)\/\d{4}\//;

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
 * Recursively collect all .csv.gz files under a directory,
 * optionally filtered by a relative scope path.
 *
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
  const prefix    = path.basename(scope);

  if (! fs.existsSync(parentDir) || ! fs.statSync(parentDir).isDirectory()) {
    return [];
  }

  return walkDir(parentDir).filter(f => path.basename(f).startsWith(prefix));
}

/** Build a SourceFile descriptor from an absolute vault file path. */
export function buildSourceFile(vaultPath: string): SourceFile {
  return {
    basePath:  vaultPath,
    tableName: tableNameFromPath(vaultPath),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract the table name from an absolute file path. Falls back to 'unknown'. */
function tableNameFromPath(filePath: string): string {
  return TABLE_NAME_PATTERN.exec(filePath)?.[1] ?? 'unknown';
}

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
  return WS_FILE_PATTERN.test(filePath) && ! path.basename(filePath).includes('.fixed.');
}
