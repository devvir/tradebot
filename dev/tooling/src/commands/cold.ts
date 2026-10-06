import { Command } from 'commander';
import inquirer from 'inquirer';
import { release } from '../tools/cold/cleanup';
import { WATCH_MS } from '../tools/cold/config';
import { isWatch, setWatch, setYes } from '../tools/cold/options';
import { error, info, setPrefix, spacer } from '../shared/ui/logger';
import type { Chosen, Origin, Selection } from '../tools/cold/types';

/**
 * The cold tools are loaded when a cold command runs, not when it is
 * registered.
 *
 * **Registration happens for every invocation.** `tools data sync` builds this
 * command's parser like any other, and a static import would pull in
 * `node:sqlite` behind it — which Node then announces with an experimental
 * warning on a command that has no database. Nothing was wrong, but a warning
 * that appears where it does not belong is a warning people learn to ignore.
 *
 * The type import above stays static: it is erased at compile time and pulls in
 * nothing at runtime.
 */
const tools = {
  push:  async (): Promise<typeof import('../tools/cold/push')>  => import('../tools/cold/push'),
  evict: async (): Promise<typeof import('../tools/cold/evict')> => import('../tools/cold/evict'),
  evictVault: async (): Promise<typeof import('../tools/cold/evict-vault')> => import('../tools/cold/evict-vault'),
  pullVault:  async (): Promise<typeof import('../tools/cold/pull-vault')>  => import('../tools/cold/pull-vault'),
  stats: async (): Promise<typeof import('../tools/cold/stats')> => import('../tools/cold/stats'),
};

/**
 * `tools cold` — everything to do with cold storage.
 *
 * Cold storage is a DX concern, not a service's job: nothing running in a
 * container reads or writes it, so it lives here and owns its own state. In
 * time every Mega call in the repo moves behind this command, and `data sync`
 * and `db dump` will ask it rather than shelling out themselves.
 */
export function register(program: Command): void {
  /**
   * Options here are every command's: given once at this level, read by each
   * command that has a use for them — see `tools/cold/options.ts`. They may be
   * written before the command or after it.
   */
  const cold = program
    .command('cold')
    .description('Cold storage: pack, upload, and account for what is backed up')
    .option('-W, --watch', 'keep running, and look again every 30 minutes')
    .option('-A, --all-sources', 'every tree, one after the other, without asking which')
    .option('-Y, --yes', 'answer yes to what a command asks before it acts');

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
    .option('-L, --lens [slug]', 'only what a catalog lens lets through; asks which when none is named')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: { lens?: string | true } = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      const push = await tools.push();

      await each(asked.origins, chosen => push.runPush(chosen, {
        venues: asked.venues,
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      }));
    }));

  cold
    .command('evict [origin] [venues...]')
    .description('Remove from disk what is in cold storage and stocked')
    .option('-n, --dry-run', 'say what would be removed, and remove nothing')
    .option('--purge', 'delete outright, where the default is the trash')
    .option('--market <market>', 'vault: only this market')
    .option('--dataset <dataset>', 'vault: only this dataset')
    .option('--variant <variant>', 'vault: only this variant of it — a kline\'s interval, funding\'s kind')
    .option('--from <yyyymm>', 'vault: from this month')
    .option('--to <yyyymm>', 'vault: through this month')
    .option('--instruments <list>', 'vault: only these instruments, comma-separated')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: Chosen = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      const how       = { ...(options.dryRun ? { dryRun: true } : {}), ...(options.purge ? { purge: true } : {}) };
      const selection = selectionOf(asked.venues, options);

      await each(asked.origins, async chosen => {
        if (chosen === 'vault') await (await tools.evictVault()).runEvictVault(selection, how);
        else await (await tools.evict()).runEvict(chosen, { venues: asked.venues, ...how });
      });
    }));

  /**
   * `evict`'s other half, and selected the same way: what one takes off the
   * disk the other brings back.
   */
  cold
    .command('pull [origin] [venues...]')
    .description('Bring back from cold storage what was evicted')
    .option('-n, --dry-run', 'say what would be brought back, and bring nothing')
    .option('--market <market>', 'only this market')
    .option('--dataset <dataset>', 'only this dataset')
    .option('--variant <variant>', 'only this variant of it — a kline\'s interval, funding\'s kind')
    .option('--from <yyyymm>', 'from this month')
    .option('--to <yyyymm>', 'through this month')
    .option('--instruments <list>', 'only these instruments, comma-separated')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: Chosen = {}, command: Command) => {
      const asked = await resolve(command, origin, venues, ['archives', 'vault']);

      if (! asked) return;

      await each(asked.origins, async chosen => {
        if (chosen === 'vault')
          await (await tools.pullVault()).runPullVault(selectionOf(asked.venues, options), options.dryRun ? { dryRun: true } : {});
        else
          error('cold pull is not built for the archives yet');
      });
    }));

  cold
    .command('audit [origin]')
    .description('Check cold storage against the record (not built on partitions yet)')
    .action(gracefully(async () => { error('cold audit is not built on partitions yet'); }));

  cold
    .command('stats [origin]')
    .description('What is in cold storage')
    .action(gracefully(async (origin: string | undefined, _options: object, command: Command) => {
      const asked = await resolve(command, origin, [], ['archives', 'vault']);

      if (! asked) return;

      const stats = await tools.stats();

      await each(asked.origins, chosen => stats.runStats(chosen));
    }));
}

// ── Internals ─────────────────────────────────────────────────────────────────

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
const each = async (origins: readonly Origin[], run: (origin: Origin) => Promise<void>): Promise<void> => {
  const several  = origins.length > 1;
  const watching = several && isWatch();

  if (watching) setWatch(false);

  for (;;) {
    for (const origin of origins) {
      setPrefix(several ? origin : null);

      // A line of its own first: not everything a command prints is a line that can carry the name.
      if (several) info('');

      await run(origin);
    }

    setPrefix(null);

    if (! watching) return;

    setYes(true);

    spacer();
    info('Watch mode - Waiting to look at every tree again');

    await new Promise(done => setTimeout(done, WATCH_MS));
  }
};

const gracefully = <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
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
const selectionOf = (venues: readonly string[], options: Chosen): Selection => ({
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
const resolve = async (
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
