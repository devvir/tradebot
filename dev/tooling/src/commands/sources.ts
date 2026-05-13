import path from 'node:path';
import { Command } from 'commander';
import { run } from '../tools/sources/index';
import { parseFromDay } from '../tools/sources/discover';
import { setDryRun, setFromDay, setLogPath, setConcurrency, setYes } from '../tools/sources/options';
import { runPrepare } from '../tools/sources/prepare/run';
import { runCheck } from '../tools/sources/check/run';
import { runStatus } from '../tools/sources/status/run';
import { runUpdate } from '../tools/sources/update/run';
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

type GlobalOpts = {
  dryRun?:      boolean;
  log?:         string | boolean;
  from?:        string;
  concurrency?: string;
  yes?:         boolean;
};

// ── Registration ──────────────────────────────────────────────────────────────

export function register(program: Command): void {
  const sources = program
    .command('sources')
    .description('Sanitise and merge vault source data')
    .option('-D, --dry-run',         'Skip writes; run the full pipeline without producing output files')
    .option('--log [dir]',           'Write logs; optional dir (default: current directory)')
    .option('--from <date>',         'Skip days before this date; accepts YYYYMMDD or YYYY-MM-DD')
    .option('-C, --concurrency <n>', 'Number of dates to process in parallel (default: 1)', '1')
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
    .description('Sort, dedup, gap-fill WS source files into WS buckets')
    .action(async (pathArg: string | undefined, _options: object, command: Command) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));
        const opts = command.optsWithGlobals<GlobalOpts>();

        setDryRun(opts.dryRun ?? false);
        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'prepare'));
        setConcurrency(Math.max(1, parseInt(opts.concurrency ?? '1', 10)));

        await runPrepare(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('check [path]')
    .description('Verify .csv.gz integrity with gzip -t; recover corrupt files with gzrecover')
    .action(async (pathArg: string | undefined, _options: object, command: Command) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));
        const opts = command.optsWithGlobals<GlobalOpts>();

        setDryRun(opts.dryRun ?? false);
        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'check'));
        setConcurrency(Math.max(1, parseInt(opts.concurrency ?? '1', 10)));

        await runCheck(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('status')
    .description('Read-only audit; print the current state of local, remotes, and Mega')
    .action(async (_options: object, command: Command) => {
      try {
        const opts = command.optsWithGlobals<GlobalOpts>();

        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'status'));

        await runStatus();
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('update')
    .description('Audit local + remotes + Mega; pull, prepare, and upload to reach a consistent state')
    .option('-y, --yes', 'Skip confirmation prompts (for cron / automation)')
    .action(async (_options: object, command: Command) => {
      try {
        const opts = command.optsWithGlobals<GlobalOpts>();

        setYes(opts.yes ?? false);
        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'update'));
        setConcurrency(Math.max(1, parseInt(opts.concurrency ?? '1', 10)));

        await runUpdate();
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
