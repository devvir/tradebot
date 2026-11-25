import { Command } from 'commander';
import { loadEnv } from './shared/utils/env';

import { register as registerRabbit } from './commands/rabbit';
import { register as registerMonitor } from './commands/monitor';
import { register as registerCold } from './commands/cold';
import { register as registerRemote } from './commands/remote';

/**
 * The `tools` command line: its global options and every command under it.
 *
 * The global options load the environment before any command's action runs.
 * An unknown command or option prints the error followed by the usage.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('tools')
    .version('1.0.0')
    .description('TradeBot development tools and utilities')
    .option('-e, --env <path>', 'Additional .env file to load (overrides every other .env file; values the shell exported still win)')
    .option('-m, --module <name>', 'Load this module\'s .env: modules/<name>/.env, else the one modules/<group>/<name>/.env')
    .showHelpAfterError()
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as any;

      loadEnv(opts.env ?? null, opts.module ?? null);
    });

  registerRabbit(program);
  registerMonitor(program);
  registerCold(program);
  registerRemote(program);

  return program;
}
