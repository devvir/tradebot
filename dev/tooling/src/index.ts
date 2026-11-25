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

import { buildProgram } from './program';
import { menuArgs } from './menu';
import { selectTool, selectFromList } from './shared/ui/prompts';
import { heading, spacer } from './shared/ui/logger';
import { DESCRIPTION as RABBIT_DESCRIPTION } from './commands/rabbit';
import { DESCRIPTION as COLD_DESCRIPTION } from './commands/cold';

interface Tool {
  id: string;
  name: string;
  description: string;
  /** The command does nothing on its own: the menu asks which of its commands to run. */
  pickSubcommand?: boolean;
}

const tools: Tool[] = [
  { id: 'rabbit', name: 'RabbitMQ', description: RABBIT_DESCRIPTION },
  { id: 'monitor', name: 'Monitor', description: 'Live dashboard: Docker containers and RabbitMQ queues' },
  { id: 'cold', name: 'Cold', description: COLD_DESCRIPTION, pickSubcommand: true },
  { id: 'remote', name: 'Remote', description: 'Remote server operations (sync-env)' },
];

async function main(): Promise<void> {
  const program = buildProgram();
  const args = process.argv.slice(2);
  const kept = menuArgs(args, Boolean(process.stdin.isTTY));

  if (kept !== null) {
    heading('TradeBot Dev Tools');
    spacer();

    const id = await selectTool(tools);
    const tool = tools.find(t => t.id === id)!;
    const chosen = [tool.id];

    if (tool.pickSubcommand) {
      const command = program.commands.find(c => c.name() === tool.id)!;
      const sub = await selectFromList(
        command.commands.map(c => ({ name: `${c.name()} - ${c.description()}`, value: c.name() })),
        `Select a ${tool.name.toLowerCase()} command:`,
      );

      if (sub !== null) chosen.push(sub);
    }

    await program.parseAsync([...kept, ...chosen], { from: 'user' });
    return;
  }

  await program.parseAsync();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
