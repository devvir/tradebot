import { Command } from 'commander';
import inquirer from 'inquirer';
import { release } from '../tools/cold/cleanup';
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
  audit: async (): Promise<typeof import('../tools/cold/audit')> => import('../tools/cold/audit'),
  evict: async (): Promise<typeof import('../tools/cold/evict')> => import('../tools/cold/evict'),
  push:  async (): Promise<typeof import('../tools/cold/push')>  => import('../tools/cold/push'),
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
  const cold = program
    .command('cold')
    .description('Cold storage: pack, upload, and account for what is backed up');

  /**
   * The venue filter sits **after** the origin and never instead of it. One
   * argument is read as the origin, so `cold push binance` is an unknown origin
   * rather than a guess about which tree was meant — the two namespaces are
   * separate and a venue name is not evidence of a tree.
   */
  cold
    .command('push [origin] [venues...]')
    .description('Pack what is not backed up yet and upload it to Mega')
    .action(gracefully(async (origin?: string, venues: string[] = []) => {
      const chosen = await resolve(origin);

      if (chosen) await (await tools.push()).runPush(chosen, venues);
    }));

  /**
   * Prompts for its origin like the rest of the family, because the safety here
   * is not in making the command awkward to name. Nothing is deleted before a
   * confirmation that lists what would go and defaults to no, and what is taken
   * goes to the host's trash rather than away. A missing argument that errors out
   * instead of asking only teaches people to type it without reading it.
   *
   * **The four filters are the vault's, and the vault's alone.** Archives have
   * no dataset, symbol or market to speak of — seven venues, seven tree shapes,
   * and no level that reliably names one — so their `SourceFile` leaves those
   * null and a filter over them could only ever match nothing. Accepting the
   * option there and quietly ignoring it is how a person comes to believe they
   * narrowed a deletion that was in fact total.
   */
  cold
    .command('evict [origin] [venues...]')
    .description('Reclaim what is safely in Mega')
    .option('--purge', 'delete outright instead of moving to the trash')
    .option('-M, --market <list>', 'vault only: markets to evict, comma-separated')
    .option('-D, --dataset <list>', 'vault only: datasets to evict, comma-separated')
    .option('-S, --symbol <list>', 'vault only: symbols to evict, comma-separated (exact)')
    .option('-P, --period <list>', 'vault only: YYYY or YYYYMM, comma-separated')
    .action(gracefully(async (
      origin?:  string,
      venues:   string[] = [],
      options: {
        purge?: boolean; market?: string; dataset?: string; symbol?: string; period?: string;
      } = {},
    ) => {
      const chosen = await resolve(origin);

      // `resolve` has already said why, so an unknown origin must not also
      // collect a second message and read as two separate problems.
      if (! chosen) return;

      const filter = {
        markets:  list(options.market),
        datasets: list(options.dataset),
        symbols:  list(options.symbol),
        periods:  list(options.period),
      };

      if (chosen !== 'vault' && Object.values(filter).some(values => values.length > 0)) {
        error(`--market, --dataset, --symbol and --period apply to the vault only — `
          + `archives are evicted a venue-month at a time`);

        return;
      }

      /**
       * Rejected here rather than matched loosely, because a period nobody can
       * match is indistinguishable from a selection that is genuinely empty —
       * and "nothing matched" is exactly what a typo looks like.
       */
      const wrong = filter.periods.filter(period => ! /^\d{4}(\d{2})?$/.test(period));

      if (wrong.length > 0) {
        error(`--period takes YYYY or YYYYMM: ${wrong.join(', ')}`);

        return;
      }

      await (await tools.evict()).runEvict(chosen, venues, filter, options.purge ?? false);
    }));

  /**
   * Read-only, so it names no origin by default and checks them all — the
   * question "is cold storage sound" is not one you ask per tree.
   */
  cold
    .command('audit [origin]')
    .description('Check cold storage against the record, and say where they differ')
    .action(gracefully(async (origin?: string) => {
      const chosen = origin ? await resolve(origin) : null;

      if (origin && ! chosen) return;

      await (await tools.audit()).runAudit(chosen ? [chosen] : ORIGINS.map(o => o.value));
    }));

  cold
    .command('stats [origin]')
    .description('What is in cold storage')
    .action(gracefully(async (origin?: string) => {
      const chosen = await resolve(origin);

      if (chosen) await (await tools.stats()).runStats(chosen);
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
const gracefully = <A extends unknown[]>(action: (...args: A) => Promise<void>) =>
  async (...args: A): Promise<void> => {
    try {
      await action(...args);
    } catch (err) {
      if (cancelled(err)) {
        release();
        spacer();
        info('Cancelled — nothing was left half-done; re-run to pick up where this stopped');
        process.exit(130);
      }

      error((err as Error).message);
      process.exit(1);
    }
  };

/**
 * A comma-separated option as the values it names.
 *
 * Lowercased here so the filter is one shape by the time anything compares it,
 * and blanks dropped so a trailing comma is a typo rather than an empty value
 * that matches nothing.
 */
const list = (given?: string): string[] =>
  (given ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);

/** Ctrl-C at a prompt, however the version of inquirer in use reports it. */
const cancelled = (err: unknown): boolean =>
  err instanceof Error
  && (err.name === 'ExitPromptError' || /force closed the prompt/i.test(err.message));

/**
 * Which tree to work on.
 *
 * Named for the tree rather than for whatever writes it. The raw archives are
 * `archives` and not `trucker` because the collector's name may change and the
 * tree's meaning will not — nothing outside that service should have to be
 * renamed with it.
 */
const ORIGINS: { value: Origin; name: string }[] = [
  { value: 'vault',    name: 'vault — stocker\'s normalised partitions' },
  { value: 'archives', name: 'archives — the raw venue trees, as published' },
  // The REST and websocket collector buckets get their own beside these.
];

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
  if (given === 'trucker') return 'archives';

  error(`Unknown origin "${given}". Known: ${ORIGINS.map(o => o.value).join(', ')}`);

  return null;
};
