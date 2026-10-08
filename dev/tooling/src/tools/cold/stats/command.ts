import { each, gracefully, resolve } from '../cli';
import type { Command } from 'commander';

/** `cold stats`: its place on the command line. The work is loaded when it runs. */
export const register = (cold: Command): void => {
  cold
    .command('stats [origin]')
    .description('What is in cold storage')
    .action(gracefully(async (origin: string | undefined, _options: object, command: Command) => {
      const asked = await resolve(command, origin, [], ['archives', 'vault']);

      if (! asked) return;

      const stats = await import('.');

      await each(asked.origins, chosen => stats.runStats(chosen));
    }));
};
