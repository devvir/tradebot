import path from 'node:path';
import { Command } from 'commander';
import { run } from '../tools/sources/index';
import { parseFromDay } from '../tools/sources/discover';
import { setDryRun, setFromDay, setLogPath } from '../tools/sources/options';
import { runPrepare } from '../tools/sources/prepare/run';
import { runCheck } from '../tools/sources/check/run';
import { input } from '../shared/ui/prompts';
import { error } from '../shared/ui/logger';
import { getEnv } from '../shared/utils/env';

// ── Path resolution ───────────────────────────────────────────────────────────

const DEFAULT_VAULT_DIR = '/data/bitmex/vault';

function vaultDir(): string {
  return getEnv('VAULT_DATA_DIR', DEFAULT_VAULT_DIR) ?? DEFAULT_VAULT_DIR;
}

/**
 * Resolve a user-supplied path argument into an absolute directory.
 *
 * Accepted formats:
 *  - omitted / empty  → VAULT_DATA_DIR
 *  - absolute path    → used as-is
 *  - relative path    → joined with VAULT_DATA_DIR
 */
function resolvePath(pathArg: string | undefined | null): string {
  if (! pathArg) return vaultDir();
  if (path.isAbsolute(pathArg)) return pathArg;

  return path.join(vaultDir(), pathArg);
}

/**
 * Resolve the --log option value into a full log file path or null.
 *
 *  - absent (undefined)  → null (no logging)
 *  - present, no value   → `<cwd>/<subcommand>.log`
 *  - present with value  → `<dir>/<subcommand>.log` (dir resolved relative to cwd)
 */
function resolveLogPath(logArg: string | boolean | undefined, subcommand: string): string | null {
  if (logArg === undefined) return null;

  const dirArg = logArg === true ? '' : logArg;
  const dir    = ! dirArg
    ? process.cwd()
    : path.isAbsolute(dirArg) ? dirArg : path.join(process.cwd(), dirArg);

  return path.join(dir, `${subcommand}.log`);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const sources = program
    .command('sources')
    .description('Sanitise and merge vault source data')
    .action(async () => {
      try {
        await run();
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('prepare [path]')
    .description('Sort, dedup, gap-fill source files into prepared/YYYYMMDD.csv.gz')
    .option('-D, --dry-run',    'Report what would be prepared without writing any output')
    .option('--log [dir]',      'Write logs; optional dir (default: current directory)')
    .option('--from <date>',    'Skip days before this date; accepts YYYYMMDD or YYYY-MM-DD')
    .action(async (pathArg: string | undefined, options: { dryRun?: boolean; log?: string | boolean; from?: string }) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));

        setDryRun(options.dryRun ?? false);
        setFromDay(parseFromDay(options.from ?? null));
        setLogPath(resolveLogPath(options.log, 'prepare'));

        await runPrepare(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('check [path]')
    .description('Verify .csv.gz integrity with gzip -t; recover corrupt files with gzrecover')
    .option('-D, --dry-run', 'Report corrupt files without recovering them')
    .option('--log [dir]',   'Write logs; optional dir (default: current directory)')
    .option('--from <date>', 'Skip files before this date; accepts YYYYMMDD or YYYY-MM-DD')
    .action(async (pathArg: string | undefined, options: { dryRun?: boolean; log?: string | boolean; from?: string }) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));

        setDryRun(options.dryRun ?? false);
        setFromDay(parseFromDay(options.from ?? null));
        setLogPath(resolveLogPath(options.log, 'check'));

        await runCheck(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
