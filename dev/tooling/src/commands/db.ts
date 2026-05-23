import { Command } from 'commander';
import { error } from '../shared/ui/logger';
import { runStats } from '../tools/db/stats';
import { runDump } from '../tools/db/dump';
import { runPurge } from '../tools/db/purge';
import { runRestore } from '../tools/db/restore';
import { runId } from '../tools/db/id';
import { run as runRepl } from '../tools/mongodb/index';

export function register(program: Command): void {
  const db = program
    .command('db')
    .alias('database')
    .description('MongoDB operations: stats, dump, restore, purge, id, repl');

  db
    .command('stats [args...]')
    .description('Collection stats. No dates → full per-collection stats (count, sizes, indexes). With dates → filtered counts per (collection, date).')
    .option('-x, --exact', 'Use countDocuments for accurate counts (slower on large collections)')
    .action(async (args: string[] = [], options: { exact?: boolean }) => {
      try {
        await runStats(args, { exact: options.exact });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('dump [args...]')
    .description('Dump collections to JSONL.gz. Args: collection names, date filters (YYYY, YYYYMM, YYYYMMDD; dashes optional), or "all".')
    .option('-o, --out <dir>', 'Output directory (overrides DB_DUMP_DIR)')
    .action(async (args: string[] = [], options: { out?: string }, command: Command) => {
      try {
        if (args.length === 0) {
          command.help();
          return;
        }

        await runDump(args, { out: options.out });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('restore [args...]')
    .description('Restore mongodump archives from local + Mega. Exact match on (collection, date); rejects coarser/finer overlaps.')
    .action(async (args: string[] = [], _options: object, command: Command) => {
      try {
        if (args.length === 0) {
          command.help();
          return;
        }

        await runRestore(args);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('purge [args...]')
    .description('Permanently delete collections × dates from MongoDB. Same arg parser as dump. Verifies Mega backup first.')
    .action(async (args: string[] = [], _options: object, command: Command) => {
      try {
        if (args.length === 0) {
          command.help();
          return;
        }

        await runPurge(args);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('id <value>')
    .description('Translate between a vault _id and an ISO date (numeric ≥ 100M → decode, date → encode)')
    .action((value: string) => {
      try {
        runId(value);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });

  db
    .command('repl')
    .description('Interactive MongoDB REPL')
    .option('-c, --collection <name>', 'Default collection for raw JSON queries')
    .action(async (options: { collection?: string }) => {
      try {
        await runRepl(undefined, { collection: options.collection });
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
