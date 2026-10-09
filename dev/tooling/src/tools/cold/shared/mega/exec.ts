import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { onExit } from '../../cleanup';
import { above } from '../progress';
import { info, warn } from '../../../../shared/ui/logger';

export const execFileAsync = promisify(execFile);

/**
 * One mega-cmd command — waited for, for as long as Mega is not answering.
 *
 * **A command that got no answer in the time it was given has not failed.**
 * Mega works through what it is asked one thing at a time, and something long —
 * a tree being moved — holds everything behind it for as long as it takes. So
 * the run waits and sends the command again, for as long as that goes on.
 * `settled` is asked before it is sent again: where what the command was for
 * has come about meanwhile — it was only the answer that never came — it is
 * not sent twice. With `once`, it is not sent again at all and the command
 * fails: for a look that is taken again shortly anyway, where waiting would
 * only stack one look behind another.
 *
 * **A command that is given up on is ended, all of it.** A mega-cmd command is
 * a script that starts the program that talks to Mega; ending the script alone
 * leaves that program waiting for an answer for as long as Mega is busy, and
 * one more of them for every time the command is sent. So each runs in a group
 * of its own, and the group is what is ended.
 *
 * **Otherwise a command that fails is one of two things**: Mega said no, or
 * Mega said nothing. They are told apart by asking it who is logged in, which
 * changes nothing and is answered at once by a Mega that is there.
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
  options: { timeout: number; maxBuffer?: number; settled?: () => Promise<boolean>; once?: boolean },
): Promise<{ stdout: string; stderr: string }> => {
  for (let wait = FIRST_MS, said = false; ;) {
    try {
      const done = await run(command, args, { timeout: options.timeout, ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}) });

      if (said) above(`Mega answered ${command}`, info);

      return done;
    } catch (err) {
      if (unanswered(err)) {
        if (options.once) throw err;

        if (! said) above(`Mega is busy: ${command} got no answer in ${Math.round(options.timeout / 1000)}s — waiting, and asking again until it does`, warn);

        said = true;

        await hold(wait);

        wait = Math.min(wait * 2, LONGEST_MS);

        if (await options.settled?.().catch(() => false)) return { stdout: '', stderr: '' };

        continue;
      }

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

/** Whether a command was stopped for taking longer than it was given, and so was never answered. */
const unanswered = (err: unknown): boolean => {
  const failed = err as { killed?: boolean; signal?: string | null; code?: unknown };

  return failed.killed === true || failed.code === 'ETIMEDOUT';
};

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

/**
 * Run a command in a process group of its own, and end the whole group where
 * it has not answered in time — failing then as a command that was stopped.
 */
const inGroup = (command: string, args: string[], options: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    // In a group of its own, it is not ended with the terminal's: so it is ended with the run.
    watched();
    running.add(child);

    const limit = options.maxBuffer ?? 1024 * 1024;

    let stdout = '';
    let stderr = '';
    let late   = false;

    const end = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    };

    const timer = setTimeout(() => { late = true; end(); }, options.timeout);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > limit) end(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err) => { clearTimeout(timer); running.delete(child); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(child);

      if (code === 0 && ! late) return resolve({ stdout, stderr });

      reject(Object.assign(new Error(`Command failed: ${command} ${args.join(' ')}${stderr ? `\n${stderr}` : ''}`), { stdout, stderr, code, killed: late }));
    });
  });

/** The commands that have not answered yet, ended with the run where it ends first. */
const running = new Set<ChildProcess>();

let watching = false;

const watched = (): void => {
  if (watching) return;

  watching = true;

  onExit(() => {
    for (const child of running) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
  });
};

let run: (command: string, args: string[], options: { timeout: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }> = inGroup;

/**
 * A wait the process stays for. A command sent again after it is the run's own
 * work going on: nothing else may be holding the process while Mega is busy,
 * and a run that ended there would have ended in the middle of what it was
 * asked to do.
 */
let hold = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Not held against the process ending: a run with nothing left to do but wait for Mega is one that may go. */
let pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

// ── Test access ───────────────────────────────────────────────────────────────

/** Stand-ins for running a command and for waiting; null puts the real ones back. */
export const _test_with = (
  runner:  typeof run | null,
  sleeper: typeof pause | null,
): void => {
  run   = runner ?? inGroup;
  pause = sleeper ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }));
  hold  = sleeper ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
};
