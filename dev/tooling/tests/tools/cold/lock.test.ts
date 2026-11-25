import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquire, orphans } from '../../../src/tools/cold/lock';
import { setYes } from '../../../src/tools/cold/options';
import { confirm } from '../../../src/shared/ui/prompts';

vi.mock('../../../src/shared/ui/prompts', () => ({ confirm: vi.fn(async () => true) }));

/**
 * One run per origin and command: a lock that is there stops a run unless it is
 * overridden, a lock whose holder is gone is cleared, and a run gives back only
 * the lock it still holds.
 */

let dir: string;

const file = (): string => path.join(dir, 'cold.archives.push.lock');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-lock-'));
  vi.mocked(confirm).mockClear();
});

afterEach(() => {
  setYes(false);
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the cold lock', () => {
  /** Whatever a look before writing says, a lock that is there is never written over. */
  it('is not taken over a lock that is held, even where a look missed it', async () => {
    // The parent process is alive: a holder that is there.
    fs.writeFileSync(file(), `pid ${process.ppid} since T\n`);

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    setYes(true);

    await expect(acquire(dir, 'archives', 'push')).rejects.toThrow(/Locked/);
    expect(fs.readFileSync(file(), 'utf8')).toBe(`pid ${process.ppid} since T\n`);
  });

  it('is given back on the way out', async () => {
    const give = await acquire(dir, 'archives', 'push');

    expect(fs.readFileSync(file(), 'utf8')).toMatch(new RegExp(`^pid ${process.pid} since `));

    give();

    expect(fs.existsSync(file())).toBe(false);
  });

  /** After an override, the run that was overridden leaves the new holder's lock where it is. */
  it('is given back only by the run that still holds it', async () => {
    const first  = await acquire(dir, 'archives', 'push');
    const second = await acquire(dir, 'archives', 'push');

    expect(confirm).toHaveBeenCalledTimes(1);

    const held = fs.readFileSync(file(), 'utf8');

    first();

    expect(fs.readFileSync(file(), 'utf8')).toBe(held);

    second();

    expect(fs.existsSync(file())).toBe(false);
  });

  it('clears a lock whose process is gone, without asking', async () => {
    fs.writeFileSync(file(), 'pid 2147483646 since T\n');

    const give = await acquire(dir, 'archives', 'push');

    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(file(), 'utf8')).toMatch(new RegExp(`^pid ${process.pid} `));

    give();
  });

  /** After a restart, the pid in a lock left behind is somebody else's. */
  it.skipIf(! fs.existsSync('/proc/sys/kernel/random/boot_id'))('takes a lock from another boot as left behind', async () => {
    fs.writeFileSync(file(), `pid ${process.ppid} since T boot another-boot token x\n`);

    expect(orphans(dir)).toEqual([path.basename(file())]);

    const give = await acquire(dir, 'archives', 'push');

    expect(confirm).not.toHaveBeenCalled();

    give();
  });
});
