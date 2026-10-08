import { each, gracefully, resolve } from '../cli';
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
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: { lens?: string | true } = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      const push = await import('./archives');

      await each(asked.origins, chosen => push.runPush(chosen, {
        venues: asked.venues,
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      }));
    }));
};
