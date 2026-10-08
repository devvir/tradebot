import { each, gracefully, resolve } from '../cli';
import type { Command } from 'commander';

/** `cold audit`: its place on the command line. The work is loaded when it runs. */
export const register = (cold: Command): void => {
  cold
    .command('audit [origin]')
    .description('Check Mega, the disk and the record against each other, and offer to put right what disagrees')
    .option('-n, --dry-run', 'say what was found, and do nothing about it')
    .action(gracefully(async (origin: string | undefined, options: { dryRun?: boolean } = {}, command: Command) => {
      const asked = await resolve(command, origin, [], ['archives', 'vault']);

      if (! asked) return;

      const audit = await import('.');

      await each(asked.origins, chosen => audit.runAudit(chosen, options.dryRun ? { dryRun: true } : {}));
    }));
};
