import { Command } from 'commander';
import inquirer from 'inquirer';
import { release } from '../tools/cold/cleanup';
import { setWatch } from '../tools/cold/options';
import { error, info, spacer } from '../shared/ui/logger';
import type { Origin } from '../tools/cold/types';

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
    .option('-W, --watch', 'keep running, and look again every 30 minutes');

  /**
   * The venue filter sits **after** the origin and never instead of it. One
   * argument is read as the origin, so `cold push binance` is an unknown origin
   * rather than a guess about which tree was meant — the two namespaces are
   * separate and a venue name is not evidence of a tree.
   */
  cold
    .command('push [origin] [venues...]')
    .description('Pack what is ready and not backed up yet, and upload it to Mega')
    .option('-L, --lens [slug]', 'only what a catalog lens lets through; asks which when none is named')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: { lens?: string | true } = {}, command: Command) => {
      shared(command);

      const chosen = await resolve(origin);

      if (! chosen || ! built(chosen)) return;

      await (await tools.push()).runPush(chosen, {
        venues: venues.map(venue => venue.toLowerCase()),
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      });
    }));

  cold
    .command('evict [origin] [venues...]')
    .description('Remove from disk what is in cold storage and stocked')
    .option('-n, --dry-run', 'say what would be removed, and remove nothing')
    .option('--purge', 'delete outright, where the default is the trash')
    .action(gracefully(async (origin: string | undefined, venues: string[] = [], options: { dryRun?: boolean; purge?: boolean } = {}, command: Command) => {
      shared(command);

      const chosen = await resolve(origin);

      if (! chosen) return;

      if (chosen !== 'archives') {
        error('cold evict is built for the archives only');

        return;
      }

      await (await tools.evict()).runEvict(chosen, {
        venues: venues.map(venue => venue.toLowerCase()),
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.purge ? { purge: true } : {}),
      });
    }));

  cold
    .command('audit [origin]')
    .description('Check cold storage against the record (not built on partitions yet)')
    .action(gracefully(async () => { error('cold audit is not built on partitions yet'); }));

  cold
    .command('stats [origin]')
    .description('What is in cold storage')
    .action(gracefully(async (origin?: string) => {
      const chosen = await resolve(origin);

      if (chosen && built(chosen)) await (await tools.stats()).runStats(chosen);
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
const shared = (command: Command): void => {
  setWatch(command.optsWithGlobals<{ watch?: boolean }>().watch ?? false);
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
  { value: 'vault',    name: 'vault — the normalised partitions (not built on partitions yet)' },
  // The REST and websocket collector buckets get their own beside these.
];

/** Whether an origin can be worked on yet; says so where it cannot. */
const built = (origin: Origin): boolean => {
  if (origin === 'archives') return true;

  error(`cold is not built for the ${origin} on partitions yet — only archives`);

  return false;
};

const resolve = async (given?: string): Promise<Origin | null> => {
  if (! given) {
    if (ORIGINS.length === 1) return ORIGINS[0]!.value;

    const { origin } = await inquirer.prompt<{ origin: Origin }>([{
      type: 'list', name: 'origin', message: 'Which tree?', choices: ORIGINS,
    }]);

    return origin;
  }

  const found = ORIGINS.find(option => option.value === given);

  if (found) return found.value;

  // What a person says when they mean the tree that service writes.
  if (given === 'stocker') return 'vault';

  error(`Unknown origin "${given}". Known: ${ORIGINS.map(o => o.value).join(', ')}`);

  return null;
};
