import { each, gracefully, resolve, selectionOf } from '../cli';
import { isWatch } from '../options';
import { error } from '../../../shared/ui/logger';
import type { Command } from 'commander';
import type { Chosen } from '../types';

/** `cold evict`: its place on the command line. The work is loaded when it runs. */
export const register = (cold: Command): void => {
  cold
    .command('evict [origin] [venues...]')
    .description('Remove from disk what is in cold storage and stocked')
    .option('-n, --dry-run', 'say what would be removed, and remove nothing')
    .option('--purge', 'delete outright, where the default is the trash')
    .option('--cleanup', 'archives: also remove whatever is on disk again of partitions already evicted — not with --watch')
    .option('--market <market>', 'vault: only this market')
    .option('--dataset <dataset>', 'vault: only this dataset')
    .option('--variant <variant>', 'vault: only this variant of it — a kline\'s interval, funding\'s kind')
    .option('--from <YYYY|YYYYMM>', 'vault: from this month, or this year\'s first')
    .option('--to <YYYY|YYYYMM>', 'vault: through this month, or this year\'s last')
    .option('--instruments <list>', 'vault: only these instruments, comma-separated')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: Chosen = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      /**
       * **Refused here, while `--watch` is still as it was given.** Watching
       * several trees, each round is repeated over all of them and each tree's
       * run is told it is not watching — so the run itself would not know.
       */
      if (options.cleanup && isWatch()) {
        error('--cleanup looks at the disk once and removes what it finds; it does not run with --watch');

        process.exitCode = 1;

        return;
      }

      const how       = { ...(options.dryRun ? { dryRun: true } : {}), ...(options.purge ? { purge: true } : {}) };
      const selection = selectionOf(asked.venues, options);

      await each(asked.origins, async chosen => {
        if (chosen === 'vault') await (await import('./vault')).runEvictVault(selection, how);
        else await (await import('./archives')).runEvict(chosen, { venues: asked.venues, ...how, ...(options.cleanup ? { cleanup: true } : {}) });
      });
    }));
};
