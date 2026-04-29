import fs from 'node:fs';
import path from 'node:path';
import { input, selectFromList } from '../../shared/ui/prompts';
import { warn, error, spacer } from '../../shared/ui/logger';
import { getEnv } from '../../shared/utils/env';
import type { RunOptions, RunMode } from './types';
import { collectFiles, buildSourceFile } from './discover';
import { runDiagnose } from './fix/run';
import { runMerge } from './merge/run';
import { runCheck } from './check/run';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function run(
  cliScope: string | null,
  cliMode:  RunMode | null,
  logDir:   string | null,
  fromDay:  string | null = null,
  yesAll:   boolean = false,
): Promise<void> {
  const { vaultDir, scope } = resolveVaultAndScope(cliScope);

  if (! fs.existsSync(vaultDir)) {
    error(`Vault directory does not exist: ${vaultDir}`);
    process.exit(1);
  }

  const opts = await resolveOptions(scope, cliMode);

  if (opts.mode === 'check' || opts.mode === 'check-dry') {
    runCheck(vaultDir, opts.scope, opts.mode === 'check-dry');
    return;
  }

  if (opts.mode === 'fix' || opts.mode === 'fix-dry') {
    const isDryRun = opts.mode === 'fix-dry';
    const files    = collectFiles(vaultDir, opts.scope).filter(f => !fromDay || dayOfFile(f) >= fromDay);
    const pairs    = files.map(f => buildSourceFile(f));

    if (pairs.length === 0) {
      warn('No files found. Nothing to fix.');
      return;
    }

    await runDiagnose(pairs, isDryRun, logDir);
    return;
  }

  const folder = resolveMergeFolder(vaultDir, opts.scope);

  await runMerge(folder, opts.mode === 'merge-dry', logDir, fromDay, yesAll);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the YYYYMMDD day prefix from a file path's basename.
 * Returns '' for files that don't start with an 8-digit day, so they always pass the filter.
 */
function dayOfFile(filePath: string): string {
  const base  = path.basename(filePath);
  const match = base.match(/^(\d{8})/);

  return match ? match[1]! : '';
}

// ── Merge folder resolution ───────────────────────────────────────────────────

/**
 * Resolve the target folder for the merge subcommand.
 *
 *  - null / blank → the vault directory itself
 *  - absolute path → used as-is
 *  - relative path → joined with the vault directory
 */
function resolveMergeFolder(vaultDir: string, scope: string | null): string {
  if (! scope) {
    return vaultDir;
  }

  return path.isAbsolute(scope) ? scope : path.join(vaultDir, scope);
}

// ── CLI resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the effective vault directory and scope from the CLI input.
 *
 * Accepted forms:
 *  - null / blank                  → env VAULT_DATA_DIR, no scope
 *  - "table" / "table/year/..."   → env VAULT_DATA_DIR, scoped
 *  - "/abs/path"                  → override vault dir, no scope
 *  - "/abs/path:filter"           → override vault dir + scope
 */
function resolveVaultAndScope(cliScope: string | null): { vaultDir: string; scope: string | null } {
  if (cliScope && cliScope.startsWith('/')) {
    const [rawPath, ...rest] = cliScope.split(':');
    const filter             = rest.join(':').trim();

    return {
      vaultDir: (rawPath ?? '').trim(),
      scope:    filter,
    };
  }

  const vaultDir = getEnv('VAULT_DATA_DIR', '/data/bitmex/vault');

  return { vaultDir: vaultDir!, scope: cliScope };
}

// ── Interactive option resolution ─────────────────────────────────────────────

async function resolveOptions(
  cliScope: string | null,
  cliMode:  RunMode | null,
): Promise<RunOptions> {
  if (cliScope !== null && cliMode !== null) {
    return { scope: cliScope || null, mode: cliMode };
  }

  spacer();

  const vaultDir = getEnv('VAULT_DATA_DIR', '/data/bitmex/vault') ?? '/data/bitmex/vault';

  const scopeInput = cliScope !== null
    ? cliScope
    : await input('Path (folder for merge; table/year scope for fix/check — blank for VAULT_DATA_DIR):', vaultDir);

  const mode = cliMode !== null
    ? cliMode
    : await selectFromList<RunMode>(
        [
          { name: 'Fix              — scan and repair a vault file, write .fixed.csv.gz',        value: 'fix'       },
          { name: 'Merge            — N-way merge all files in a folder by day, .merged.csv.gz', value: 'merge'     },
          { name: 'Check            — verify gz integrity and recover corrupt files',             value: 'check'     },
          { name: 'Fix (dry-run)    — scan and report, no output written',                       value: 'fix-dry'   },
          { name: 'Merge (dry-run)  — report what would be merged, no output written',           value: 'merge-dry' },
          { name: 'Check (dry-run)  — report corrupt files, no recovery',                        value: 'check-dry' },
        ],
        'Mode:',
      ) ?? 'fix';

  return { scope: scopeInput.trim() || null, mode };
}
