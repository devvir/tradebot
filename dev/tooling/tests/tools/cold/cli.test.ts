import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { each } from '../../../src/tools/cold/cli';
import { WATCH_MS } from '../../../src/tools/cold/config';
import { isWatch, isYes, setWatch, setYes } from '../../../src/tools/cold/options';
import * as backup from '../../../src/tools/cold/shared/backup';
import type { Origin } from '../../../src/tools/cold/types';
import { coldConfigFor } from './fixtures';

/**
 * Running a command over each tree, and keeping one going that was asked to:
 * the round over several trees, and the retries of a command that fails while
 * it is left watching.
 */

const where = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/tools/cold/config', async actual => ({
  ...await actual<object>(),
  loadConfig: () => coldConfigFor(where.dir),
}));

vi.mock('../../../src/tools/cold/shared/backup', () => ({
  check:     vi.fn(async () => {}),
  save:      vi.fn(async () => {}),
  recordOf:  vi.fn(() => ({ name: 'record' })),
  ledgersOf: vi.fn(() => [{ name: 'ledger' }]),
}));

vi.mock('../../../src/shared/ui/logger', async actual => ({
  ...await actual<object>(),
  info: vi.fn(), error: vi.fn(), spacer: vi.fn(), setPrefix: vi.fn(),
}));

/** What ends a watching run: Ctrl-C at a prompt, which no retry outlasts. */
const stopped = (): Error => Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' });

beforeEach(() => {
  where.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-cli-'));
  vi.useFakeTimers();
  vi.mocked(backup.save).mockClear();
  vi.mocked(backup.check).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  setWatch(false);
  setYes(false);
  fs.rmSync(where.dir, { recursive: true, force: true });
});

describe('a command over several trees, left watching', () => {
  it('runs each tree once a round, one after the other, and the round again after the wait', async () => {
    setWatch(true);

    const ran: Origin[] = [];
    const run = vi.fn(async (origin: Origin) => {
      if (ran.length === 4) throw stopped();

      ran.push(origin);
    });

    const going = each(['archives', 'vault'], run);
    const ended = expect(going).rejects.toThrow(/force closed/);

    await vi.advanceTimersByTimeAsync(0);

    expect(ran).toEqual(['archives', 'vault']);

    await vi.advanceTimersByTimeAsync(WATCH_MS - 1);

    expect(ran).toEqual(['archives', 'vault']);

    await vi.advanceTimersByTimeAsync(1);

    expect(ran).toEqual(['archives', 'vault', 'archives', 'vault']);

    await vi.advanceTimersByTimeAsync(WATCH_MS);
    await ended;
  });

  /** Each tree's command looks again only as the round comes: it is not left watching by itself. */
  it('runs each tree\'s command as one that does not watch', async () => {
    setWatch(true);

    const watching: boolean[] = [];
    const going = each(['archives', 'vault'], async () => {
      if (watching.length === 2) throw stopped();

      watching.push(isWatch());
    });
    const ended = expect(going).rejects.toThrow(/force closed/);

    await vi.advanceTimersByTimeAsync(WATCH_MS);
    await ended;

    expect(watching).toEqual([false, false]);
  });

  it('asks in the first round, and answers yes from the second on', async () => {
    setWatch(true);

    const yes: boolean[] = [];
    const going = each(['archives', 'vault'], async () => {
      if (yes.length === 4) throw stopped();

      yes.push(isYes());
    });
    const ended = expect(going).rejects.toThrow(/force closed/);

    await vi.advanceTimersByTimeAsync(2 * WATCH_MS);
    await ended;

    expect(yes).toEqual([false, false, true, true]);
  });

  it('sends cold\'s own files after each tree, with the ledgers after the vault', async () => {
    await each(['archives', 'vault'], async () => {});

    const sent = vi.mocked(backup.save).mock.calls.map(call => call[1].map(one => one.name));

    expect(sent).toEqual([['record'], ['record', 'ledger']]);
    expect(backup.check).toHaveBeenCalledTimes(1);
  });

  it('runs each tree once, and ends, where it is not watching', async () => {
    const run = vi.fn(async () => {});

    await each(['archives', 'vault'], run);

    expect(run.mock.calls).toEqual([['archives'], ['vault']]);
  });
});

describe('a command left watching that fails', () => {
  it('fails as it would without watching, where it fails as it starts', async () => {
    setWatch(true);

    const run = vi.fn(async () => { throw new Error('a lock somebody holds'); });

    await expect(each(['archives'], run)).rejects.toThrow(/a lock somebody holds/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is run again after a wait that doubles up to a minute, once it has been going a minute', async () => {
    setWatch(true);

    const at: number[] = [];
    const began = Date.now();
    const run = vi.fn(async () => {
      at.push(Date.now() - began);

      // Going for a minute before the first failure; then failing four times more, and getting through.
      if (at.length === 1) vi.setSystemTime(began + 60_000);

      if (at.length <= 5) throw new Error('Mega would not answer');
    });

    const going = each(['archives'], run);

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000 + 20_000 + 40_000 + 60_000);
    await going;

    expect(run).toHaveBeenCalledTimes(6);

    // The waits between the runs: 5s, then doubled each time, and no longer than a minute.
    const waits = at.slice(1).map((one, n) => one - at[n]!);

    expect(waits.slice(1)).toEqual([10_000, 20_000, 40_000, 60_000]);
  });

  it('answers yes from the first retry on, since nobody is there to ask', async () => {
    setWatch(true);

    const yes: boolean[] = [];
    const began = Date.now();
    const going = each(['archives'], async () => {
      yes.push(isYes());
      vi.setSystemTime(began + 60_000);

      if (yes.length === 1) throw new Error('Mega would not answer');
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await going;

    expect(yes).toEqual([false, true]);
  });

  it('is not run again where it was stopped at a prompt', async () => {
    setWatch(true);

    const began = Date.now();
    const run = vi.fn(async () => {
      vi.setSystemTime(began + 60_000);

      throw stopped();
    });

    await expect(each(['archives'], run)).rejects.toThrow(/force closed/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
