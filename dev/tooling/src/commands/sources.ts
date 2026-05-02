import { Command } from 'commander';
import { run } from '../tools/sources/index.js';
import { parseFromDay } from '../tools/sources/merge/discover.js';
import { runDaily } from '../tools/sources/daily/run.js';
import { error } from '../shared/ui/logger';

/**
 * Register the `sources` command group.
 *
 * Sub-commands:
 *   sources fix   [path] [--dry-run|-D] [--log <dir>]                     — scan a single file; optionally write fixed output
 *   sources merge [path] [--dry-run|-D] [--log <dir>] [--from <YYYYMMDD>] — merge a vault+gaps pair; optionally dry-run
 *   sources check [path] [--dry-run|-D]                                    — verify gz integrity; recover corrupt files unless --dry-run
 *   sources daily [--date <YYYYMMDD>]                                      — full daily ingestion pipeline
 *
 * Running `sources` with no sub-command drops into the interactive menu.
 * The `--log` flag lives only on the subcommands — declaring it on the
 * parent as well caused commander to route the value to whichever command
 * encountered the flag first.
 */
type SourcesOpts = { dryRun?: boolean; log?: string };
type FixOpts     = SourcesOpts & { from?: string };
type MergeOpts   = SourcesOpts & { from?: string; yes?: boolean };

export function register(program: Command): void {
  const sources = program
    .command('sources [path]')
    .description('Sanitise and merge vault source data')
    .action(async (scopeArg: string | undefined) => {
      try {
        await run(scopeArg ?? null, null, null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('fix [path]')
    .description('Scan a vault file for issues; write a fixed copy unless --dry-run')
    .option('-D, --dry-run', 'Scan and report only — do not write the fixed file')
    .option('--log <dir>',   'Write a per-task log file into this directory')
    .option('--from <date>', 'Skip files dated before this date; accepts YYYYMMDD or YYYY-MM-DD')
    .action(async (scopeArg: string | undefined, options: FixOpts) => {
      try {
        const fromDay = parseFromDay(options.from ?? null);
        await run(scopeArg ?? null, options.dryRun ? 'fix-dry' : 'fix', options.log ?? null, fromDay);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('merge [path]')
    .description('N-way merge all *.csv.gz files in a folder by day (YYYYMMDD prefix); outputs YYYYMMDD.merged.csv.gz')
    .option('-D, --dry-run', 'Report what would be merged without writing any output')
    .option('-y, --yes',     'Accept all merge confirmations without prompting')
    .option('--log <dir>',   'Write a per-day log file into this directory')
    .option('--from <date>', 'Skip days before this date; accepts YYYYMMDD or YYYY-MM-DD')
    .action(async (scopeArg: string | undefined, options: MergeOpts) => {
      try {
        const fromDay = parseFromDay(options.from ?? null);
        await run(scopeArg ?? null, options.dryRun ? 'merge-dry' : 'merge', options.log ?? null, fromDay, options.yes ?? false);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('check [path]')
    .description('Verify gz integrity of vault files; recover corrupt files unless --dry-run')
    .option('-D, --dry-run', 'Report corrupt files only — do not run gzrecover')
    .action(async (scopeArg: string | undefined, options: SourcesOpts) => {
      try {
        await run(scopeArg ?? null, options.dryRun ? 'check-dry' : 'check', null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('daily')
    .description('Full daily ingestion pipeline: import, upload raw, fix, merge, fix, upload vault')
    .option('--date <date>', 'Date to process (YYYYMMDD or YYYY-MM-DD); defaults to yesterday UTC')
    .action(async (options: { date?: string }) => {
      try {
        await runDaily(options.date ?? null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
