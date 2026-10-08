import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { info, warn } from '../../../../shared/ui/logger';

export const execFileAsync = promisify(execFile);

/**
 * One mega-cmd command — waited for, for as long as Mega is not answering.
 *
 * **A command that fails is one of two things**: Mega said no, or Mega said
 * nothing. They are told apart by asking it who is logged in, which changes
 * nothing and is answered at once by a Mega that is there.
 *
 * - **It answers**: the failure is the command's own — a path that is not
 *   there, a refusal — and is the caller's to make sense of.
 * - **It does not**: nothing can be concluded and nothing is. The run waits,
 *   asking again after 5 seconds and then twice as long each time up to a
 *   minute, and sends the command again once Mega is back. Nothing moves
 *   forward meanwhile: a run left going rides out an outage of any length, and
 *   what it was told before the outage is not mistaken for what Mega holds.
 */
export const megaCmd = async (
  command: string,
  args:    string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> => {
  for (;;) {
    try {
      return await run(command, args, options);
    } catch (err) {
      if (await answering()) throw err;

      await untilAnswering();
    }
  }
};

/** Whether mega-cmd answers at all: who is logged in, which asks nothing of the account. */
export const answering = async (): Promise<boolean> => {
  try {
    await run('mega-whoami', [], { timeout: ANSWER_MS });

    return true;
  } catch {
    return false;
  }
};

/** Whether a command failed because what it was asked about is not there — which is an answer, and not a failure. */
export const notThere = (err: unknown): boolean => {
  const said = err as { stdout?: string; stderr?: string; message?: string };

  return /Couldn't find/i.test(`${said.stdout ?? ''}${said.stderr ?? ''}${said.message ?? ''}`);
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** Wait until Mega answers, saying so once as the wait begins and once as it ends. */
const untilAnswering = async (): Promise<void> => {
  warn('Mega is not answering — waiting for it, and nothing moves on until it does');

  for (let wait = FIRST_MS; ; wait = Math.min(wait * 2, LONGEST_MS)) {
    await pause(wait);

    if (await answering()) break;
  }

  info('Mega is answering again');
};

/** The first wait, and the longest: doubled each time between the two. */
const FIRST_MS   = 5_000;
const LONGEST_MS = 60_000;

/** How long Mega is given to say who is logged in. */
const ANSWER_MS = 20_000;

let run: (command: string, args: string[], options: { timeout: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }> =
  (command, args, options) => execFileAsync(command, args, options);

/** Not held against the process ending: a run with nothing left to do but wait for Mega is one that may go. */
let pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

// ── Test access ───────────────────────────────────────────────────────────────

/** Stand-ins for running a command and for waiting; null puts the real ones back. */
export const _test_with = (
  runner:  typeof run | null,
  sleeper: typeof pause | null,
): void => {
  run   = runner ?? ((command, args, options) => execFileAsync(command, args, options));
  pause = sleeper ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }));
};
