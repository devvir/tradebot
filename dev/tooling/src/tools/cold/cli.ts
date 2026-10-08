import inquirer from 'inquirer';
import { release } from './cleanup';
import { WATCH_MS, loadConfig } from './config';
import { busy, orphaned } from './lock';
import { isWatch, setWatch, setYes } from './options';
import { error, info, setPrefix, spacer } from '../../shared/ui/logger';
import type { Command } from 'commander';
import type { Chosen, Origin, Selection } from './types';

/**
 * What every `cold` command's registration is built from: which trees and
 * venues a line means, running a command over each tree, and ending on a
 * sentence.
 *
 * Nothing here loads a command's own code — see `commands/cold.ts`.
 */

/** Take the options given at the `cold` level, wherever on the line they were written. */
const shared = (command: Command): { allSources: boolean } => {
  const given = command.optsWithGlobals<{ watch?: boolean; yes?: boolean; allSources?: boolean }>();

  setWatch(given.watch ?? false);
  setYes(given.yes ?? false);

  return { allSources: given.allSources ?? false };
};

/**
 * Run a command for each tree in turn.
 *
 * **With more than one, every line says which tree it is about**, and nothing
 * else is done to tell them apart.
 *
 * **Watching several, each is seen through before the next begins**, and the
 * whole round comes again after the wait. A command watching one tree looks
 * again by itself, in the middle of its own work; over several that would never
 * hand over to the next, so here it is the round that repeats. What a command
 * asks, it asks in the first round and not again.
 */
export const each = async (origins: readonly Origin[], run: (origin: Origin) => Promise<void>): Promise<void> => {
  const several  = origins.length > 1;
  const watching = several && isWatch();

  if (watching) setWatch(false);

  /**
   * **Cold's own files are looked after around every command** — see
   * `shared/backup.ts`. The record's copy in Mega is checked before the first
   * tree, since a run that died before this one may have left it behind; and
   * after each tree the record is sent if it changed, with the vault's ledgers
   * where the tree was the vault. A command that keeps running by itself sends
   * them as it goes.
   *
   * **Not checked while another command is running.** That one is changing the
   * record as this one starts, so the two differ as a matter of course, and it
   * sends the record itself as it goes and as it ends.
   */
  const backup = await import('./shared/backup');
  const config = loadConfig(origins[0] ?? 'archives');

  if (! busy(config.coldRoot)) await backup.check(config, orphaned(config.coldRoot));

  for (;;) {
    for (const origin of origins) {
      setPrefix(several ? origin : null);

      // A line of its own first: not everything a command prints is a line that can carry the name.
      if (several) info('');

      await run(origin);

      await backup.save(config, [backup.recordOf(config), ...(origin === 'vault' ? backup.ledgersOf(config) : [])]);
    }

    setPrefix(null);

    if (! watching) return;

    setYes(true);

    spacer();
    info('Watch mode - Waiting to look at every tree again');

    await new Promise(done => setTimeout(done, WATCH_MS));
  }
};

/**
 * End on a sentence rather than a stack trace.
 *
 * Two reasons an action's rejection escapes to the runtime. Commander's
 * `parse()` does not await an async action, so anything it throws becomes an
 * unhandled rejection that Node prints in full and exits on. And Ctrl-C at an
 * inquirer prompt is not an error at all — it rejects with `ExitPromptError`,
 * which is the user answering, not the tool failing.
 *
 * So the action is wrapped here rather than at the entry point: every other
 * command keeps whatever behaviour it has, and `cold` answers a Ctrl-C the way
 * a command-line tool should.
 */
export const gracefully = <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await action(...args);
    } catch (err) {
      if (cancelled(err)) {
        release();
        spacer();
        info('Stopped - will resume on next restart');
        process.exit(130);
      }

      error((err as Error).message);
      process.exit(1);
    }
  };

/** Ctrl-C at a prompt, however the version of inquirer in use reports it. */
const cancelled = (err: unknown): boolean =>
  err instanceof Error
  && (err.name === 'ExitPromptError' || /force closed the prompt/i.test(err.message));

/**
 * Which tree to work on.
 *
 * Named for the tree rather than for whatever writes it. The raw archives are
 * `archives` and not a collector's name, because the collector may change and
 * the tree's meaning will not.
 */
const ORIGINS: { value: Origin; name: string }[] = [
  { value: 'archives', name: 'archives — the venues\' archive files, as published' },
  { value: 'vault',    name: 'vault — the stocked partitions, as Parquet' },
  // The REST and websocket collector buckets get their own beside these.
];

/** What narrows a command to part of the vault, as it is written on the line. */
export const selectionOf = (venues: readonly string[], options: Chosen): Selection => ({
  venues:      venues.map(venue => venue.toLowerCase()),
  instruments: (options.instruments ?? '').split(',').map(one => one.trim()).filter(Boolean),
  ...(options.market  ? { market: options.market }   : {}),
  ...(options.dataset ? { dataset: options.dataset } : {}),
  ...(options.variant ? { variant: options.variant } : {}),
  ...(options.from    ? { from: options.from.replace('-', '') } : {}),
  ...(options.to      ? { to: options.to.replace('-', '') }     : {}),
});

/**
 * Which trees a command is for, and which venues.
 *
 * **Every tree, unless one is named.** With nothing said, the choice is asked
 * for, and every tree is the first answer; `--all-sources` gives that answer
 * without asking, which is what a script or a crontab needs. `offered` is the
 * trees the command is built for: with one, there is nothing to choose.
 *
 * **With every tree, the first argument is a venue too.** The origin's place on
 * the line is empty, so whatever sits there is the first of the venues.
 */
export const resolve = async (
  command: Command,
  given:   string | undefined,
  venues:  readonly string[],
  offered: readonly Origin[],
): Promise<{ origins: Origin[]; venues: string[] } | null> => {
  const { allSources } = shared(command);
  const lower = (names: readonly string[]): string[] => names.map(name => name.toLowerCase());

  if (allSources || given === ALL)
    return { origins: [...offered], venues: lower(given && given !== ALL ? [given, ...venues] : venues) };

  if (given) {
    // What a person says when they mean the tree that service writes.
    const named = given === 'stocker' ? 'vault' : given;

    if (offered.includes(named as Origin)) return { origins: [named as Origin], venues: lower(venues) };

    error(ORIGINS.some(option => option.value === named)
      ? `This command is not built for the ${named} — only ${offered.join(', ')}`
      : `Unknown origin "${given}". Known: ${[ALL, ...offered].join(', ')}`);

    return null;
  }

  if (offered.length === 1) return { origins: [...offered], venues: lower(venues) };

  const { origin } = await inquirer.prompt<{ origin: Origin | typeof ALL }>([{
    type: 'list', name: 'origin', message: 'Which tree?', default: ALL,
    choices: [
      { value: ALL, name: 'all — every tree, one after the other' },
      ...ORIGINS.filter(option => offered.includes(option.value)),
    ],
  }]);

  return { origins: origin === ALL ? [...offered] : [origin], venues: lower(venues) };
};

/** What is said for every tree at once. */
const ALL = 'all';
