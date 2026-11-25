import { each, gracefully, resolve, snapshotOf } from '../cli';
import { setYes } from '../options';
import { warn } from '../../../shared/ui/logger';
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
    .option('-l, --lens [slug]', 'archives: only what a catalog lens lets through; asks which when none is named')
    .option('--rebase', 'catalog: send the whole database again as a new base, and drop what was sent since the last')
    .option('-n, --dry-run', 'catalog: say what would be sent, and send nothing')
    .option('--keep-snapshot', 'catalog: keep on disk the snapshot this run takes — it is removed once sent otherwise')
    .option('--drop-snapshot', 'catalog: remove a snapshot found on disk, on a run that takes none')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: PushFlags = {}, command: Command) => {
      /**
       * **The catalog is not a tree of data, and is not among the sources**: it
       * is named, and never part of `--all-sources`. It is not read through a
       * lens.
       */
      if (origin === CATALOG) {
        if (options.lens !== undefined) throw new Error('--lens narrows the archives: the catalog\'s copy is always of the whole catalog');

        setYes(command.optsWithGlobals<{ yes?: boolean }>().yes ?? false);

        const how = {
          ...(options.rebase ? { rebase: true } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...snapshotOf(options),
        };

        // Around it, cold's own files are looked after as around any other command: the catalog's copy is written into the record.
        await each(['archives'], async () => (await import('./catalog')).runPushCatalog(how));

        return;
      }

      /** What only the catalog's copy takes is refused anywhere else, before anything is asked or sent. */
      const catalogOnly = CATALOG_FLAGS.filter(([key]) => options[key]).map(([, flag]) => flag);

      if (catalogOnly.length > 0)
        throw new Error(`${catalogOnly.join(', ')} ${catalogOnly.length === 1 ? 'is' : 'are'} only for \`cold push catalog\`, never for a tree`);

      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      /** **The vault is not read through a lens**: it is stored as its ledger has it, and asks nothing of the catalog. */
      if (options.lens !== undefined && asked.origins.includes('vault')) {
        if (asked.origins.length === 1) throw new Error('--lens narrows the archives: the vault is always pushed whole');

        warn('--lens narrows the archives only: the vault is pushed whole');
      }

      const push = await import('./archives');

      await each(asked.origins, chosen => push.runPush(chosen, {
        venues: asked.venues,
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      }), { watches: true });
    }));
};

/** What the catalog's copy is asked for by, where a tree would be named. */
const CATALOG = 'catalog';

/** What `cold push` can be told, as commander gives it. */
type PushFlags = { lens?: string | true; rebase?: boolean; dryRun?: boolean; keepSnapshot?: boolean; dropSnapshot?: boolean };

/** The options only the catalog's copy takes, and how each is written on the line. */
const CATALOG_FLAGS: readonly [keyof PushFlags, string][] = [
  ['dryRun', '--dry-run'], ['rebase', '--rebase'], ['keepSnapshot', '--keep-snapshot'], ['dropSnapshot', '--drop-snapshot'],
];
