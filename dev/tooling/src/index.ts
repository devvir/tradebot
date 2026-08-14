#!/usr/bin/env node

/**
 * Node's warning that `node:sqlite` is experimental, and nothing else.
 *
 * It is true, unactionable, and printed on every `cold` command — which is the
 * definition of a warning people learn to scroll past, taking the ones that
 * matter with it. The module is a deliberate choice: the alternative is a
 * native dependency to be rebuilt against every Node version, for a database
 * this reads and writes from one process.
 *
 * **Filtered rather than silenced.** `--no-warnings` would hide deprecations
 * and every future experimental feature too; this drops exactly one message and
 * prints the rest as Node would. Removing the default listener first is what
 * makes that possible — Node prints from its own handler, which stays in place
 * if you merely add another.
 *
 * It runs before any import that could trigger it, which is why it is here
 * rather than beside the database.
 */
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;

  console.warn(`${warning.name}: ${warning.message}`);
});

import { Command } from 'commander';
import { loadEnv } from './shared/utils/env';
import { selectTool } from './shared/ui/prompts';
import { heading, spacer } from './shared/ui/logger';

import { register as registerWs } from './commands/ws';
import { register as registerRabbit } from './commands/rabbit';
import { register as registerBouncer } from './commands/bouncer';
import { register as registerBroadcast } from './commands/broadcast';
import { register as registerMonitor } from './commands/monitor';
import { register as registerData } from './commands/data';
import { register as registerCold } from './commands/cold';
import { register as registerRemote } from './commands/remote';
import { register as registerSynth } from './commands/synth';

interface Tool {
  id: string;
  name: string;
  description: string;
}

const tools: Tool[] = [
  { id: 'ws', name: 'WebSocket', description: 'Connect to BitMEX WebSocket with authentication' },
  { id: 'rabbit', name: 'RabbitMQ', description: 'Monitor RabbitMQ queues and streams' },
  { id: 'bouncer', name: 'Bouncer', description: 'View accounts and auth tokens from Bouncer' },
  { id: 'broadcast', name: 'Broadcast', description: 'Monitor broadcast exchange messages' },
  { id: 'monitor', name: 'Monitor', description: 'Live dashboard: Docker containers and RabbitMQ queues' },
  { id: 'data', name: 'Data', description: 'Prepare, sync, and recover vault data' },
  { id: 'cold', name: 'Cold', description: 'Cold storage: pack, upload, and account for backups' },
  { id: 'remote', name: 'Remote', description: 'Remote server operations (sync-env, pull)' },
  { id: 'synth', name: 'Synth', description: 'Synthetic data tools (index, generate)' },
];

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('tools')
    .version('1.0.0')
    .description('TradeBot development tools and utilities')
    .option('-e, --env <path>', 'Additional .env file to load (overrides root and module .env)')
    .option('-m, --module <name>', 'Load this module\'s .env (modules/<name>/.env)')
    .option('-v, --verbose', 'Verbose output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts() as any;

      loadEnv(opts.env ?? null, opts.module ?? null);

      if (opts.verbose) {
        process.env.DEBUG = '1';
      }
    });

  registerWs(program);
  registerRabbit(program);
  registerBouncer(program);
  registerBroadcast(program);
  registerMonitor(program);
  registerData(program);
  registerCold(program);
  registerRemote(program);
  registerSynth(program);

  // Show interactive menu when no subcommand is given.
  // Preserve any global flags (-e, --env, -v, --verbose) so they survive the
  // menu selection and are still applied when the chosen command runs.
  const rawArgs = process.argv.slice(2);
  const commandNames = new Set(program.commands.flatMap(cmd => [cmd.name(), ...cmd.aliases()]));
  const hasSubcommand = rawArgs.some(arg => commandNames.has(arg));

  if (! hasSubcommand) {
    heading('TradeBot Dev Tools');
    spacer();

    const selectedTool = await selectTool(tools);

    // Extract global options to preserve them alongside the selected subcommand
    const globalArgs: string[] = [];
    const flagsWithValues = new Set(['-e', '--env', '-m', '--module']);

    for (let i = 0; i < rawArgs.length; i++) {
      if (flagsWithValues.has(rawArgs[i])) {
        globalArgs.push(rawArgs[i], rawArgs[i + 1]);
        i++;
      } else if (rawArgs[i] === '-v' || rawArgs[i] === '--verbose') {
        globalArgs.push(rawArgs[i]);
      }
    }

    process.argv = ['node', 'tools', ...globalArgs, selectedTool];
  }

  program.parse();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
