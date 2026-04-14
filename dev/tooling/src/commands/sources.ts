import { Command } from 'commander';
import { run } from '../tools/sources/index.js';
import { error } from '../shared/ui/logger';

/**
 * Register the `sources` command group.
 *
 * Sub-commands:
 *   sources fix   [path] [--dry-run|-D] [--log <dir>]  — scan a single file; optionally write fixed output
 *   sources merge [path] [--dry-run|-D] [--log <dir>]  — merge a vault+gaps pair; optionally dry-run
 *
 * Running `sources` with no sub-command drops into the interactive menu.
 * The `--log` flag lives only on the subcommands — declaring it on the
 * parent as well caused commander to route the value to whichever command
 * encountered the flag first.
 */
type SourcesOpts = { dryRun?: boolean; log?: string };

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
    .option('--log <dir>', 'Write a per-task log file into this directory')
    .action(async (scopeArg: string | undefined, options: SourcesOpts) => {
      try {
        await run(scopeArg ?? null, options.dryRun ? 'fix-dry' : 'fix', options.log ?? null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  sources
    .command('merge [path]')
    .description('Merge a vault+gaps file pair into a single output; requires a gaps counterpart')
    .option('-D, --dry-run', 'Smoke-test and report gap/overlap info without writing output')
    .option('--log <dir>', 'Write a per-task log file into this directory')
    .action(async (scopeArg: string | undefined, options: SourcesOpts) => {
      try {
        await run(scopeArg ?? null, options.dryRun ? 'merge-dry' : 'merge', options.log ?? null);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
