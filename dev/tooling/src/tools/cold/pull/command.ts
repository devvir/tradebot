import { each, gracefully, resolve, selectionOf } from '../cli';
import type { Command } from 'commander';
import type { Chosen } from '../types';

/** `cold pull`: its place on the command line. The work is loaded when it runs. */
export const register = (cold: Command): void => {
  /**
   * Asked for by what is wanted, never by a venue alone: a venue is everything
   * it ever published, and nobody means to bring all of that back.
   */
  cold
    .command('pull [origin] [venues...]')
    .description('Bring back from cold storage: a venue\'s dataset, or a partition of it')
    .option('-n, --dry-run', 'say what would be brought back, and bring nothing')
    .option('-f, --force', 'archives: bring back what is on disk already too, over it, without asking')
    .option('--dataset <dataset[,variant]>', 'this dataset, in every market — every variant of it, or the one named')
    .option('--partition <market[/dataset[,variant][/YYYY[MM]]]>', 'this market, or as much of a partition of it as is given')
    .option('--date <YYYY|YYYYMM>', 'only this year, or this month')
    .option('--instruments <list>', 'vault: only these instruments, comma-separated')
    .option('--prefer-monthly', 'archives: where a month is stored at more than one grain, the monthly files')
    .option('--prefer-daily', 'archives: where a month is stored at more than one grain, the daily files')
    .option('--prefer-bundled', 'archives: where a month is stored both ways, the files holding a whole market')
    .option('--prefer-not-bundled', 'archives: where a month is stored both ways, the files of one instrument each')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: Chosen = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      if (asked.venues.length === 0) throw new Error('A pull needs a venue');

      const { filterOf, preferenceOf } = await import('./filter');

      const filter = filterOf(options);
      const prefer = preferenceOf(options);
      const how    = options.dryRun ? { dryRun: true } : {};

      // The vault holds one rendering of a month: a preference says nothing there, and asking it of the vault alone is a mistake.
      if (Object.keys(prefer).length > 0 && asked.origins.length === 1 && asked.origins[0] === 'vault')
        throw new Error('A preference for a grain or a bundle is the archives\': the vault holds each month one way');

      await each(asked.origins, async chosen => {
        if (chosen === 'vault')
          await (await import('./vault')).runPullVault({ ...selectionOf(asked.venues, options), ...filter }, how);
        else
          await (await import('./archives')).runPull(chosen, { venues: asked.venues, filter, prefer, ...how, ...(options.force ? { force: true } : {}) });
      });
    }));
};
