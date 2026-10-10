import { Command } from 'commander';
import { register as audit } from '../tools/cold/audit/command';
import { register as evict } from '../tools/cold/evict/command';
import { register as pull } from '../tools/cold/pull/command';
import { register as push } from '../tools/cold/push/command';
import { register as stats } from '../tools/cold/stats/command';

/**
 * The cold tools are loaded when a cold command runs, not when it is
 * registered.
 *
 * **Registration happens for every invocation.** Any other command builds this
 * one's parser beside its own, and a static import would pull in
 * `node:sqlite` behind it — which Node then announces with an experimental
 * warning on a command that has no database. Nothing was wrong, but a warning
 * that appears where it does not belong is a warning people learn to ignore.
 *
 * So each command is registered by a module of its own that holds only its
 * place on the line, and imports the work behind it when it runs.
 */

/**
 * `tools cold` — everything to do with cold storage.
 *
 * Cold storage is a DX concern, not a service's job: nothing running in a
 * container reads or writes it, so it lives here and owns its own state.
 * Every Mega call in the repo is behind this command.
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
    .option('-w, --watch', 'keep running, and look again every 30 minutes')
    .option('-a, --all-sources', 'every tree, one after the other, without asking which')
    .option('-y, --yes', 'answer what a command asks before it acts: each question\'s own default');

  push(cold);
  evict(cold);
  pull(cold);

  audit(cold);
  stats(cold);
}
