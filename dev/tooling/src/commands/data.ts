import path from 'node:path';
import { Command } from 'commander';
import { run } from '../tools/data/index';
import { parseFromDay } from '../tools/data/discover';
import { setDryRun, setFromDay, setLogPath, setConcurrency, setYes } from '../tools/data/options';
import { runPrepare } from '../tools/data/prepare/run';
import { runRecover } from '../tools/data/recover/run';
import { runStatus } from '../tools/data/status/run';
import { runSync } from '../tools/data/sync/run';
import { runDedup } from '../tools/data/dedup/run';
import { runRebucket } from '../tools/data/rebucket/run';
import { input } from '../shared/ui/prompts';
import { error } from '../shared/ui/logger';
import { requiredEnv } from '../shared/utils/env';

// ── Path resolution ───────────────────────────────────────────────────────────

function vaultDir(): string {
  return requiredEnv('VAULT_DATA_DIR');
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
  const data = program
    .command('data')
    .description('Prepare, sync, and recover vault data')
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

  data
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

  data
    .command('recover [path]')
    .description('Verify .csv.gz integrity with gzip -t; recover corrupt files with gzrecover')
    .action(async (pathArg: string | undefined, _options: object, command: Command) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));
        const opts = command.optsWithGlobals<GlobalOpts>();

        setDryRun(opts.dryRun ?? false);
        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'recover'));
        setConcurrency(Math.max(1, parseInt(opts.concurrency ?? '1', 10)));

        await runRecover(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  data
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

  data
    .command('sync')
    .description('Audit local + remotes + Mega; pull, prepare, and upload to reach a consistent state')
    .option('-y, --yes', 'Skip confirmation prompts (for cron / automation)')
    .action(async (_options: object, command: Command) => {
      try {
        const opts = command.optsWithGlobals<GlobalOpts>();

        setYes(opts.yes ?? false);
        setFromDay(parseFromDay(opts.from ?? null));
        setLogPath(resolveLogPath(opts.log, 'sync'));
        setConcurrency(Math.max(1, parseInt(opts.concurrency ?? '1', 10)));

        await runSync();
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  data
    .command('dedup [path]')
    .description('Content-hash dedup source files; writes <original>.dedup.csv.gz siblings')
    .option('-T, --threshold <ms>', 'Max lag (ms) behind the monotonic clock to treat an already-seen message as a duplicate', '500')
    .option('-W, --window <millions>', 'Recency window size in millions of keys (split across two rotating sets); raise to catch far-apart ghost duplicates', '1')
    .action(async (pathArg: string | undefined, options: { threshold?: string; window?: string }, command: Command) => {
      try {
        const root           = resolvePath(pathArg ?? await input('Path:', vaultDir()));
        const opts           = command.optsWithGlobals<GlobalOpts>();
        const thresholdMs    = Math.max(0, parseInt(options.threshold ?? '500', 10));
        const windowMillions = Math.max(1, parseInt(options.window ?? '1', 10));

        setDryRun(opts.dryRun ?? false);
        setFromDay(parseFromDay(opts.from ?? null));

        await runDedup(root, thresholdMs, windowMillions);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  data
    .command('rebucket [path]')
    .description('One-time: refile CSV messages into day buckets by their timestamp; reads <day>.<infix>.csv, writes <day>.<infix>.rebucketed.csv (decompress/recompress with pigz yourself)')
    .action(async (pathArg: string | undefined, _options: object, command: Command) => {
      try {
        const root = resolvePath(pathArg ?? await input('Path:', vaultDir()));
        const opts = command.optsWithGlobals<GlobalOpts>();

        setDryRun(opts.dryRun ?? false);

        await runRebucket(root);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
