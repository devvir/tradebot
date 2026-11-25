import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/commands/cold';
import { runEvict } from '../../../src/tools/cold/evict/archives';
import { runEvictVault } from '../../../src/tools/cold/evict/vault';
import { setWatch } from '../../../src/tools/cold/options';

vi.mock('../../../src/tools/cold/evict/archives', () => ({ runEvict: vi.fn(async () => {}) }));
vi.mock('../../../src/tools/cold/evict/vault', () => ({ runEvictVault: vi.fn(async () => {}) }));

/** `cold evict` on the command line, before any tree is worked on. */

const parse = async (...args: string[]): Promise<void> => {
  const program = new Command().exitOverride();

  register(program);

  await program.parseAsync(['node', 'tb', ...args]);
};

afterEach(() => {
  process.exitCode = undefined;
  setWatch(false);
  vi.clearAllMocks();
});

describe('cold evict --cleanup', () => {
  /** Watching several trees, each tree's run is not told it is watching: the line itself is refused. */
  it.each([
    ['after the command', ['cold', 'evict', '--all-sources', '--watch', '--cleanup']],
    ['before the command', ['cold', '--watch', '-a', 'evict', '--cleanup']],
    ['with one tree', ['cold', 'evict', 'archives', '--watch', '--cleanup']],
  ])('is refused with --watch given %s, and nothing is evicted', async (_, args) => {
    await parse(...args);

    expect(runEvict).not.toHaveBeenCalled();
    expect(runEvictVault).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
