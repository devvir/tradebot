import fs from 'node:fs';
import { input, selectFromList } from '../../shared/ui/prompts';
import { warn, error, spacer } from '../../shared/ui/logger';
import { getEnv } from '../../shared/utils/env';
import type { RunOptions, RunMode } from './types';
import { collectFiles, buildSingleFilePair } from './discover';
import { runDiagnose } from './fix/run';
import { runMerge } from './merge/run';
import { runCheck } from './check/run';

// ── Entry point ───────────────────────────────────────────────────────────────

export async function run(
  cliScope: string | null,
  cliMode:  RunMode | null,
  logDir:   string | null,
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
    const pairs    = collectFiles(vaultDir, opts.scope).map(f => buildSingleFilePair(vaultDir, f));

    if (pairs.length === 0) {
      warn('No files found. Nothing to fix.');
      return;
    }

    await runDiagnose(pairs, isDryRun, logDir);
    return;
  }

  await runMerge(vaultDir, opts.scope, opts.mode === 'merge-dry', logDir);
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

  const scopeInput = cliScope !== null
    ? cliScope
    : await input('Scope (table, table/year, table/year/file — blank for all):');

  const mode = cliMode !== null
    ? cliMode
    : await selectFromList<RunMode>(
        [
          { name: 'Fix              — scan and repair a vault file, write .fixed.csv.gz', value: 'fix'       },
          { name: 'Merge            — merge a vault+gaps pair, write .merged.csv.gz',     value: 'merge'     },
          { name: 'Check            — verify gz integrity and recover corrupt files',      value: 'check'     },
          { name: 'Fix (dry-run)    — scan and report, no output written',                value: 'fix-dry'   },
          { name: 'Merge (dry-run)  — smoke-test and report, no output written',          value: 'merge-dry' },
          { name: 'Check (dry-run)  — report corrupt files, no recovery',                 value: 'check-dry' },
        ],
        'Mode:',
      ) ?? 'fix';

  return { scope: scopeInput.trim() || null, mode };
}
