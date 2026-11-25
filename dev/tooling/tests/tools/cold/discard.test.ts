import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discard } from '../../../src/tools/cold/evict/discard';
import { execFileAsync } from '../../../src/tools/cold/shared/exec';

vi.mock('../../../src/tools/cold/shared/exec', () => ({ execFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' })) }));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-discard-'));
  vi.mocked(execFileAsync).mockClear();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('taking files off the disk outright', () => {
  /** A signal is only heard when the thread is handed back: a removal that never does cannot be stopped. */
  it('hands the thread back on every call, however little it removes', async () => {
    let heard = 0;

    for (let at = 0; at < 5; at++) {
      const file = path.join(dir, `f${at}`);

      fs.writeFileSync(file, 'x');
      setImmediate(() => { heard++; });

      await discard([file], true);

      expect(fs.existsSync(file)).toBe(false);
      expect(heard).toBe(at + 1);
    }
  });

  it('asks nothing of the trash', async () => {
    fs.writeFileSync(path.join(dir, 'f'), 'x');

    await discard([path.join(dir, 'f')], true);

    expect(execFileAsync).not.toHaveBeenCalled();
  });
});

describe('taking files to the trash', () => {
  it('hands them to the host\'s trash, and removes nothing itself', async () => {
    const file = path.join(dir, 'f');

    fs.writeFileSync(file, 'x');

    await discard([file], false);

    expect(execFileAsync).toHaveBeenCalledWith('gio', ['trash', file], expect.anything());
    expect(fs.existsSync(file)).toBe(true);
  });

  it('hands over a few hundred at a time, every one of them once', async () => {
    const paths = Array.from({ length: 1201 }, (_, at) => path.join(dir, `f${at}`));

    await discard(paths, false);

    const calls = vi.mocked(execFileAsync).mock.calls.map(call => (call[1] as string[]).slice(1));

    expect(calls.map(one => one.length)).toEqual([500, 500, 201]);
    expect(calls.flat()).toEqual(paths);
  });

  /** A trash that fails is never retried as a delete. */
  it('fails where the trash does, and deletes nothing in its place', async () => {
    const file = path.join(dir, 'f');

    fs.writeFileSync(file, 'x');
    vi.mocked(execFileAsync).mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stderr: 'no trash on this volume' }));

    await expect(discard([file], false)).rejects.toThrow(/gio trash failed: no trash on this volume/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('stops at the batch that failed, and hands over nothing after it', async () => {
    const paths = Array.from({ length: 1201 }, (_, at) => path.join(dir, `f${at}`));

    vi.mocked(execFileAsync)
      .mockResolvedValueOnce({ stdout: '', stderr: '' } as never)
      .mockRejectedValueOnce(new Error('exit 1'));

    await expect(discard(paths, false)).rejects.toThrow(/gio trash failed/);
    expect(execFileAsync).toHaveBeenCalledTimes(2);
  });
});
