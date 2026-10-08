import { each, gracefully, resolve, snapshotOf } from '../cli';
import { setYes } from '../options';
import type { Command } from 'commander';

/** `cold push`: its place on the command line. The work is loaded when it runs. */
export const register = (cold: Command): void => {
  /**
   * The venue filter sits **after** the origin and never instead of it. One
   * argument is read as the origin, so `cold push binance` is an unknown origin
   * rather than a guess about which tree was meant — the two namespaces are
   * separate and a venue name is not evidence of a tree. With `--all-sources`
   * there is no origin to name, and every argument is a venue.
   */
  cold
    .command('push [origin] [venues...]')
    .description('Pack what is ready and not backed up yet, and upload it to Mega')
    .option('-l, --lens [slug]', 'only what a catalog lens lets through; asks which when none is named')
    .option('--rebase', 'catalog: send the whole database again as a new base, and drop what was sent since the last')
    .option('-n, --dry-run', 'catalog: say what would be sent, and send nothing')
    .option('--keep-snapshot', 'catalog: keep on disk the snapshot this run takes — it is removed once sent otherwise')
    .option('--drop-snapshot', 'catalog: remove a snapshot found on disk, on a run that takes none')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: { lens?: string | true; rebase?: boolean; dryRun?: boolean; keepSnapshot?: boolean; dropSnapshot?: boolean } = {}, command: Command) => {
      /**
       * **The catalog is not a tree of data, and is not among the sources**: it
       * is named, and never part of `--all-sources`.
       */
      if (origin === CATALOG) {
        setYes(command.optsWithGlobals<{ yes?: boolean }>().yes ?? false);

        await (await import('./catalog')).runPushCatalog({
          ...(options.rebase ? { rebase: true } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...snapshotOf(options),
        });

        return;
      }

      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      const push = await import('./archives');

      await each(asked.origins, chosen => push.runPush(chosen, {
        venues: asked.venues,
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      }));
    }));
};

/** What the catalog's copy is asked for by, where a tree would be named. */
const CATALOG = 'catalog';
