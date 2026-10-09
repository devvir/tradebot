import { each, gracefully, resolve, selectionOf, snapshotOf } from '../cli';
import { setWatch, setYes } from '../options';
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
    .description('Bring back from cold storage: a venue\'s dataset, or a partition of it — or `needed`, whatever the vault waits for')
    .option('-n, --dry-run', 'say what would be brought back, and bring nothing')
    .option('-f, --force', 'archives: bring back what is on disk already too, over it, without asking')
    .option('--dataset <dataset[,variant]>', 'this dataset, in every market — every variant of it, or the one named')
    .option('--partition <market[/dataset[,variant][/YYYY[MM]]]>', 'this market, or as much of a partition of it as is given')
    .option('--date <YYYY|YYYYMM>', 'only this year, or this month')
    .option('--instruments <list>', 'vault: only these instruments, comma-separated')
    .option('-o, --output <path>', 'catalog: where the database is left — a directory, or the file itself; refused where it is already there')
    .option('--keep-snapshot', 'catalog: leave the snapshot on disk afterwards, even where it had to be brought back')
    .option('--drop-snapshot', 'catalog: leave no snapshot on disk afterwards — the one there becomes the database')
    .option('--prefer-monthly', 'archives: where a month is stored at more than one grain, the monthly files')
    .option('--prefer-daily', 'archives: where a month is stored at more than one grain, the daily files')
    .option('--prefer-bundled', 'archives: where a month is stored both ways, the files holding a whole market')
    .option('--prefer-not-bundled', 'archives: where a month is stored both ways, the files of one instrument each')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: Chosen = {}, command: Command) => {
      // The catalog is not a tree of data: it is asked for by name, and takes none of what narrows a tree.
      if (origin === 'catalog') {
        setYes(command.optsWithGlobals<{ yes?: boolean }>().yes ?? false);

        await (await import('./catalog')).runPullCatalog({
          ...(options.output ? { output: options.output } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...snapshotOf(options),
        });

        return;
      }

      /**
       * **What the vault waits for is not a tree either**: it is whatever of the
       * archives and of the vault a partition is stuck without, and is asked
       * for by that name alone.
       */
      if (origin === NEEDED) {
        const given = command.optsWithGlobals<{ yes?: boolean; watch?: boolean }>();

        setYes(given.yes ?? false);
        setWatch(given.watch ?? false);

        await each(['archives'], async () => (await import('./needed')).runPullNeeded(options.dryRun ? { dryRun: true } : {}));

        return;
      }

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

/** What is asked for in an origin's place to bring back whatever the vault waits for. */
const NEEDED = 'needed';
