import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../../src/commands/cold';
import { runEvict } from '../../../src/tools/cold/evict/archives';
import { runEvictVault } from '../../../src/tools/cold/evict/vault';
import { selectionOf } from '../../../src/tools/cold/cli';
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

describe('the months of the vault a command is narrowed to', () => {
  it('is a month as it is written, with or without a dash', () => {
    expect(selectionOf([], { from: '2025-03', to: '202506' })).toMatchObject({ from: '202503', to: '202506' });
  });

  /** A year from its first month, and through its last. */
  it('is a year from its January and through its December', () => {
    expect(selectionOf([], { from: '2025' }).from).toBe('202501');
    expect(selectionOf([], { to: '2025' }).to).toBe('202512');
  });

  it.each([['2025-1'], ['20251'], ['202513'], ['25-01'], ['2025-01-01']])('refuses "%s"', (month) => {
    expect(() => selectionOf([], { to: month })).toThrow(/--to is YYYY or YYYYMM/);
    expect(() => selectionOf([], { from: month })).toThrow(/--from is YYYY or YYYYMM/);
  });

  it('refuses a start after its end', () => {
    expect(() => selectionOf([], { from: '202506', to: '2025-03' })).toThrow(/after/);
  });

  it('is refused on the command line, and nothing is evicted', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`); });
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(parse('cold', 'evict', 'vault', '--to', '2025-1')).rejects.toThrow('exit 1');

      expect(said.mock.calls.flat().join('\n')).toMatch(/--to is YYYY or YYYYMM, not "2025-1"/);
      expect(runEvictVault).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      said.mockRestore();
    }
  });
});
