#!/usr/bin/env node

import { Command } from 'commander';
import { loadEnv } from './shared/utils/env.js';
import { selectTool } from './shared/ui/prompts.js';
import { heading, spacer } from './shared/ui/logger.js';

import { register as registerWs } from './commands/ws.js';
import { register as registerDb } from './commands/db.js';
import { register as registerRabbit } from './commands/rabbit.js';
import { register as registerBouncer } from './commands/bouncer.js';
import { register as registerBroadcast } from './commands/broadcast.js';
import { register as registerSignal } from './commands/signal.js';import { register as registerMonitor } from './commands/monitor';
interface Tool {
  id: string;
  name: string;
  description: string;
}

const tools: Tool[] = [
  { id: 'ws', name: 'WebSocket', description: 'Connect to BitMEX WebSocket with authentication' },
  { id: 'db', name: 'MongoDB', description: 'Query and explore MongoDB database' },
  { id: 'rabbit', name: 'RabbitMQ', description: 'Monitor RabbitMQ queues and streams' },
  { id: 'bouncer', name: 'Bouncer', description: 'View accounts and auth tokens from Bouncer' },
  { id: 'broadcast', name: 'Broadcast', description: 'Monitor broadcast exchange messages' },
  { id: 'signal', name: 'Signal', description: 'View signals and indicators from Signal service' },
  { id: 'monitor', name: 'Monitor', description: 'Live dashboard: Docker containers and RabbitMQ queues' },
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
  registerDb(program);
  registerRabbit(program);
  registerBouncer(program);
  registerBroadcast(program);
  registerSignal(program);
  registerMonitor(program);

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
