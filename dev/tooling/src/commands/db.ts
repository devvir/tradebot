import { Command } from 'commander';
import { run as runMongoDBTool } from '../tools/mongodb/index.js';
import { error } from '../shared/ui/logger.js';

export function register(program: Command): void {
  program
    .command('db [query]')
    .alias('database')
    .description('Connect to MongoDB and run queries')
    .option('-c, --collection <name>', 'Collection to query')
    .option('-l, --list', 'List all collections in current database')
    .action(async (queryArg: string | undefined, options: any) => {
      try {
        await runMongoDBTool(queryArg, options);
      } catch (err) {
        error((err as Error).message);
        process.exit(1);
      }
    });
}
