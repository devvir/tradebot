import { afterEach, describe, expect, it, vi } from 'vitest';
import { follow } from '../../../src/tools/cold/shared/progress-mega';
import { waitingFor } from '../../../src/tools/cold/shared/progress';
import type { Progress } from '../../../src/tools/cold/shared/progress';
import type { Bar, Following, Transfer } from '../../../src/tools/cold/shared/types';

/**
 * A queue of Mega's as a source of progress: which files of it are meant, and
 * whether the line is of all of them together or of the one moving now, are
 * things it is told — the line itself is the block's to draw.
 */

/** A block that keeps what it is handed, and runs a source when told to. */
const block = () => {
  const bars = new Map<string, Bar>();

  let tick: () => void | Promise<void> = () => {};
  let stopped = false;

  const progress = {
    set:   (id: string, bar: Bar | null) => { if (bar) bars.set(id, bar); else bars.delete(id); },
    every: (_ms: number, run: () => void | Promise<void>) => { tick = run; return () => { stopped = true; }; },
  } as unknown as Progress;

  return { progress, bars, look: async () => { await tick(); }, stopped: () => stopped };
};

const file = (path: string, percent: number, bytes: number, active = false): Transfer => ({ path, percent, bytes, active });

const following = (queue: Transfer[], told: Partial<Following>): Following =>
  ({ id: 'line', queue: 'downloads', label: 'files', read: async () => queue, ...told });

describe('following a queue of Mega\'s', () => {
  it('shows the one file moving now, by what it is told to call it', async () => {
    const { progress, bars, look } = block();

    follow(progress, following([file('/a/one.tar', 100, 50), file('/a/two.tar', 25, 200, true)], { label: moving => `↓ ${moving.path}` }));

    await look();

    expect(bars.get('line')).toMatchObject({ label: '↓ /a/two.tar', done: 50, total: 200, unit: 'bytes' });
  });

  it('says so where nothing is moving, or shows no line where it has nothing to say', async () => {
    const quiet = block();

    follow(quiet.progress, following([file('/a/one.tar', 0, 50)], { idle: 'nothing uploading' }));
    await quiet.look();

    expect(quiet.bars.get('line')).toMatchObject({ label: 'nothing uploading', quiet: true });

    const none = block();

    follow(none.progress, following([], {}));
    await none.look();

    expect(none.bars.size).toBe(0);
  });

  /** What has left the queue has arrived: what is left there is taken from the whole. */
  it('shows all of a run\'s files together, by bytes or by how many', async () => {
    const queue = [file('/mine/a', 50, 100, true), file('/mine/b', 0, 300), file('/other/c', 0, 9_000)];
    const told  = { mine: (path: string) => path.startsWith('/mine/'), total: { files: 5, bytes: 1_000 } };

    const bytes = block();

    follow(bytes.progress, following(queue, told));
    await bytes.look();

    // 1,000 in all; 50 of a and all 300 of b still to come.
    expect(bytes.bars.get('line')).toMatchObject({ label: 'files', done: 650, total: 1_000, unit: 'bytes' });

    const files = block();

    follow(files.progress, following(queue, { ...told, count: 'files' }));
    await files.look();

    expect(files.bars.get('line')).toMatchObject({ done: 3, total: 5, unit: 'count', of: 'files' });
  });

  it('takes its line away when it is stopped', async () => {
    const { progress, bars, look, stopped } = block();

    const stop = follow(progress, following([file('/a/one.tar', 10, 50, true)], {}));

    await look();

    expect(bars.size).toBe(1);

    stop();

    expect(stopped()).toBe(true);
    expect(bars.size).toBe(0);
  });
});

describe('a line written over in place', () => {
  const tty = process.stdout.isTTY;

  afterEach(() => {
    process.stdout.isTTY = tty;

    vi.restoreAllMocks();
  });

  it('opens with an hourglass unless told otherwise, and is taken away with nothing', () => {
    process.stdout.isTTY = true;

    const written: string[] = [];

    vi.spyOn(process.stdout, 'write').mockImplementation((text: unknown) => (written.push(String(text)), true));

    waitingFor('Retrying in 5 seconds…');
    waitingFor('nothing to bring', '✓');
    waitingFor(null);

    expect(written).toEqual(['\r\x1b[K⏳ Retrying in 5 seconds…', '\r\x1b[K✓ nothing to bring', '\r\x1b[K']);
  });

  it('writes nothing where there is no terminal to write over', () => {
    process.stdout.isTTY = false;

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    waitingFor('nothing to bring', '✓');

    expect(write).not.toHaveBeenCalled();
  });
});
